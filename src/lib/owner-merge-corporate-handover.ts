/**
 * 法人のペアを統合するとき、消える側（source）の項目をどう残すか（2026-11-24 発注者承認）。
 *
 * 法人は「同じ会社が別の住所・電話で二重に登録されている」ことが多い。統合は source を
 * archive するだけなので、そのままでは source にだけある値が見えなくなる。
 *
 * | 項目 | master が空・source に値 | 両方に値があって違う | 同じ（表記の違いだけ） |
 * |---|---|---|---|
 * | 登記上の住所（address） | master へ写す | 写さない（source の住所は必ず記録に残る） | 何もしない |
 * | 郵便番号（zip） | 住所を写すとき・同じ住所のときだけ写す | 写さず記録に残す | 何もしない |
 * | 電話（phone） | 写す | 写さず記録に残す | 何もしない |
 * | 法人番号（corporateNumber・13桁） | 13桁にそろえて写す | 統合の門で止まる（別の法人） | 何もしない |
 * | 会社法人等番号（companyRegistryNumber・12桁） | 12桁にそろえて写す | 統合の門で止まる（別の法人） | 何もしない |
 * | メール（email） | 写す | 写さず記録に残す | 何もしない（大文字小文字は同じ扱い） |
 * | フリガナ（nameKana） | 写す | 写さず記録に残す | 何もしない（空白の違いは同じ扱い） |
 * | 名前（name） | （master に必ずある） | 写さず記録に残す（㈱/株式会社 などの書き方の違いも） | 何もしない |
 *
 * ⚠source の登記上の住所は、写したかどうかに関わらず必ず master の変更履歴に1行残す
 *   （`_merged_source_address`）。どの住所で登録されていた会社をまとめたかを後から追える。
 * ⚠個人のペアには使わない（個人は従来どおり何も写さない）。
 *
 * ## Owner の残りの列の扱い（review P2・2026-11-24）
 * 法人のペアは「source に変更履歴があれば止める」門を通らないので、人が直した列が
 * 1つも消えないことをここで決める（prisma の Owner モデルの全列）:
 * - currentAddress / currentZip: 既存の現住所の引き継ぎ（owner-merge-current-address.ts）が扱う。
 * - note / externalLinkKey: source に値があれば統合の門で止まる（引き継ぐ先が無い）。
 * - id / version / isArchived / createdAt / updatedAt: 統合の仕組みの列（人は編集しない）。写さない。
 * - 物件・メモ・DM・添付のつながり（別の表）: 統合の本体が master へ付け替える。
 * ⚠Owner に人が編集する列を足したら、この表と planCorporateFieldHandover に足す。
 *
 * 純関数。値そのもの（住所・電話など）を返すのは変更履歴に書くためで、
 * API レスポンス・AuditLog には項目名（enum）しか出さない。
 */
import { normalizeAddress } from "@/lib/normalize";
import { normalizeZipForGroup } from "@/lib/owner-mailing-address";
import {
  normalizeCorporateNumber,
  normalizeCompanyRegistryNumber,
} from "@/lib/corporate-number";

export type CorporateHandoverField =
  | "address"
  | "zip"
  | "phone"
  | "corporateNumber"
  | "companyRegistryNumber"
  | "email"
  | "nameKana"
  | "name";

export interface CorporateHandoverState {
  address: string | null;
  zip: string | null;
  phone: string | null;
  corporateNumber: string | null;
  // 以下は review P2 で追加。渡されないときは「空」とみなす。
  companyRegistryNumber?: string | null;
  email?: string | null;
  nameKana?: string | null;
  /** 名前は写さない（master に必ずある）。書き方が違えば記録に残すだけ。 */
  name?: string | null;
}

export interface CorporateHandoverPlan {
  /** master へ写す値（master が空の項目だけ）。 */
  writes: Partial<Record<CorporateHandoverField, string>>;
  /** 写さないが、消えないよう master の変更履歴に残す source の値（住所は sourceAddress で残る）。 */
  keptSourceValues: Array<{ field: CorporateHandoverField; value: string }>;
  /** 必ず記録に残す source の登記上の住所（空なら null）。 */
  sourceAddress: string | null;
}

/**
 * 写す項目ごとに要る「明示の編集権限」（通常の編集経路 PATCH /api/owners/[id] と同じ境界）。
 * 会社法人等番号は所有者の編集でも owner_corporate_number で守られている。
 * 名前は写さない（記録だけ）ので実際には要らないが、型をそろえるため owner_name を置く。
 */
export const CORPORATE_HANDOVER_PERMISSION: Readonly<Record<CorporateHandoverField, string>> = {
  address: "owner_address",
  zip: "owner_zip",
  phone: "owner_phone",
  corporateNumber: "owner_corporate_number",
  companyRegistryNumber: "owner_corporate_number",
  email: "owner_email",
  nameKana: "owner_name_kana",
  name: "owner_name",
};

type Writes = CorporateHandoverPlan["writes"];
type Kept = CorporateHandoverPlan["keptSourceValues"];

function trimmed(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

function phoneDigits(v: string): string {
  return v.normalize("NFKC").replace(/\D/g, "");
}

/** 比べるだけの値（NFKC・空白を除く）。 */
function compact(v: string): string {
  return v.normalize("NFKC").replace(/[\s　]+/gu, "");
}

/** 文字の項目: master が空なら写す・同じとみなせなければ写さず残す。 */
function planText(
  field: "phone" | "email" | "nameKana",
  masterRaw: string,
  srcRaw: string,
  same: (a: string, b: string) => boolean,
  writes: Writes,
  kept: Kept,
): void {
  if (srcRaw === "") return;
  if (masterRaw === "") writes[field] = srcRaw;
  else if (!same(masterRaw, srcRaw)) kept.push({ field, value: srcRaw });
}

/**
 * 番号の項目: master が空なら そろえた値 を写す。そろえられない番号・master 側が読めない
 * ときは写さず残す（両方そろって違うときは統合の門で先に止まっている）。
 */
function planNumber(
  field: "corporateNumber" | "companyRegistryNumber",
  masterRaw: string,
  srcRaw: string,
  normalize: (v: string) => string | null,
  writes: Writes,
  kept: Kept,
): void {
  if (srcRaw === "") return;
  const srcN = normalize(srcRaw);
  const masterN = normalize(masterRaw);
  if (masterRaw === "" && srcN !== null) {
    writes[field] = srcN;
  } else if (srcN === null || srcN !== masterN) {
    kept.push({ field, value: srcRaw });
  }
}

export function planCorporateFieldHandover(
  master: CorporateHandoverState,
  source: CorporateHandoverState,
): CorporateHandoverPlan {
  const writes: Writes = {};
  const kept: Kept = [];

  // 住所と郵便番号（郵便番号は住所とそろうときだけ写す＝別の住所の番号を混ぜない）
  const srcAddress = trimmed(source.address);
  const masterAddress = trimmed(master.address);
  const srcZip = trimmed(source.zip);
  const masterZip = trimmed(master.zip);
  let zipBelongsToMasterAddress = false;
  if (srcAddress !== "") {
    if (masterAddress === "") {
      writes.address = srcAddress;
      zipBelongsToMasterAddress = true;
    } else if (normalizeAddress(masterAddress) === normalizeAddress(srcAddress)) {
      zipBelongsToMasterAddress = true;
    }
  }
  if (srcZip !== "") {
    const sameZip = normalizeZipForGroup(masterZip) === normalizeZipForGroup(srcZip);
    if (masterZip === "" && zipBelongsToMasterAddress) {
      writes.zip = srcZip;
    } else if (!sameZip) {
      kept.push({ field: "zip", value: srcZip });
    }
  }

  // 電話（数字だけで比べる）
  planText("phone", trimmed(master.phone), trimmed(source.phone),
    (a, b) => phoneDigits(a) === phoneDigits(b), writes, kept);

  // 法人番号（13桁）・会社法人等番号（12桁）
  planNumber("corporateNumber", trimmed(master.corporateNumber),
    trimmed(source.corporateNumber), normalizeCorporateNumber, writes, kept);
  planNumber("companyRegistryNumber", trimmed(master.companyRegistryNumber),
    trimmed(source.companyRegistryNumber), normalizeCompanyRegistryNumber, writes, kept);

  // メール（大文字小文字は同じ扱い）・フリガナ（空白の違いは同じ扱い）
  planText("email", trimmed(master.email), trimmed(source.email),
    (a, b) => a.toLowerCase() === b.toLowerCase(), writes, kept);
  planText("nameKana", trimmed(master.nameKana), trimmed(source.nameKana),
    (a, b) => compact(a) === compact(b), writes, kept);

  // 名前: master の名前は変えない。書き方が違えば source の名前を残す
  const srcName = trimmed(source.name);
  if (srcName !== "" && compact(srcName) !== compact(trimmed(master.name))) {
    kept.push({ field: "name", value: srcName });
  }

  return {
    writes,
    keptSourceValues: kept,
    sourceAddress: srcAddress === "" ? null : srcAddress,
  };
}

/** 計画どおり master へ写すのに要る明示の編集権限（重複なし）。 */
export function requiredCorporateHandoverPermissions(
  plan: CorporateHandoverPlan,
): string[] {
  return [
    ...new Set(
      (Object.keys(plan.writes) as CorporateHandoverField[]).map(
        (f) => CORPORATE_HANDOVER_PERMISSION[f],
      ),
    ),
  ];
}
