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
 * | 法人番号（corporateNumber） | 13桁にそろえて写す | 統合の門で止まる（別の法人） | 何もしない |
 *
 * ⚠source の登記上の住所は、写したかどうかに関わらず必ず master の変更履歴に1行残す
 *   （`_merged_source_address`）。どの住所で登録されていた会社をまとめたかを後から追える。
 * ⚠個人のペアには使わない（個人は従来どおり何も写さない）。
 *
 * 純関数。値そのもの（住所・電話）を返すのは変更履歴に書くためで、
 * API レスポンス・AuditLog には項目名（enum）しか出さない。
 */
import { normalizeAddress } from "@/lib/normalize";
import { normalizeZipForGroup } from "@/lib/owner-mailing-address";
import { normalizeCorporateNumber } from "@/lib/corporate-number";

export type CorporateHandoverField = "address" | "zip" | "phone" | "corporateNumber";

export interface CorporateHandoverState {
  address: string | null;
  zip: string | null;
  phone: string | null;
  corporateNumber: string | null;
}

export interface CorporateHandoverPlan {
  /** master へ写す値（master が空の項目だけ）。 */
  writes: Partial<Record<CorporateHandoverField, string>>;
  /** 写さないが、消えないよう master の変更履歴に残す source の値（住所は sourceAddress で残る）。 */
  keptSourceValues: Array<{ field: CorporateHandoverField; value: string }>;
  /** 必ず記録に残す source の登記上の住所（空なら null）。 */
  sourceAddress: string | null;
}

/** 写す項目ごとに要る「明示の編集権限」（通常の編集経路と同じ境界）。 */
export const CORPORATE_HANDOVER_PERMISSION: Readonly<Record<CorporateHandoverField, string>> = {
  address: "owner_address",
  zip: "owner_zip",
  phone: "owner_phone",
  corporateNumber: "owner_corporate_number",
};

function trimmed(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

function phoneDigits(v: string): string {
  return v.normalize("NFKC").replace(/\D/g, "");
}

export function planCorporateFieldHandover(
  master: CorporateHandoverState,
  source: CorporateHandoverState,
): CorporateHandoverPlan {
  const writes: CorporateHandoverPlan["writes"] = {};
  const kept: CorporateHandoverPlan["keptSourceValues"] = [];

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
  const srcPhone = trimmed(source.phone);
  const masterPhone = trimmed(master.phone);
  if (srcPhone !== "") {
    if (masterPhone === "") {
      writes.phone = srcPhone;
    } else if (phoneDigits(masterPhone) !== phoneDigits(srcPhone)) {
      kept.push({ field: "phone", value: srcPhone });
    }
  }

  // 法人番号（13桁にそろえて写す。両方あって違うのは統合の門で止まる）
  const srcCnRaw = trimmed(source.corporateNumber);
  const masterCnRaw = trimmed(master.corporateNumber);
  if (srcCnRaw !== "") {
    const srcCn = normalizeCorporateNumber(srcCnRaw);
    const masterCn = normalizeCorporateNumber(masterCnRaw);
    if (masterCnRaw === "" && srcCn !== null) {
      writes.corporateNumber = srcCn;
    } else if (srcCn === null || srcCn !== masterCn) {
      // 形が崩れている番号・master 側の番号が読めないときは写さず残す
      kept.push({ field: "corporateNumber", value: srcCnRaw });
    }
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
  return (Object.keys(plan.writes) as CorporateHandoverField[]).map(
    (f) => CORPORATE_HANDOVER_PERMISSION[f],
  );
}
