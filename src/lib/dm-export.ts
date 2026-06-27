/**
 * DM 差込 CSV 出力の純粋ヘルパー群（route から分離し単体テスト可能にする）。
 *
 * GET /api/properties/dm-export が「送付可（dmStatus=send）」の物件を
 * 「同一物件内・同一送付先住所の所有者 = 1 行」に展開する際の
 * ヘッダ定義・グルーピング・宛名生成・敬称判定・表示レベル判定・行マッピングを担う。
 *
 * 送付方針（PR-3a）:
 *  - 同一物件内で「郵便番号 + 住所」が同じ共有者は 1 通にまとめる（重複送付しない）。
 *  - 氏名はグルーピングキーに含めない（名義が違っても同住所なら 1 通）。
 *  - 宛先は Owner.zip / Owner.address のみ。Property / Building.postalCode は使わない。
 *
 * PII / 表示レベル:
 *  - 所有者名 / 郵便番号 / 住所 / 氏名カナは ownerDisplayConfig + maskValue に従う。
 *  - maskValue が「生値」を返す表示レベル（full / read / edit）でのみ DM 出力を許可する想定。
 *    その判定を isPlainOwnerLevel として route 側のゲートで再利用する。
 */
import { maskValue } from "@/lib/permissions";
import { PROPERTY_TYPE_LABELS, DM_STATUS_LABELS } from "@/lib/property-types";
import { honorificForOwner } from "@/lib/owner-honorific";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";
import { OTHER_CO_OWNERS_SUFFIX } from "@/lib/sale-dm-letter/addressee";

// CSV ヘッダ（差込テンプレートの列順に厳密一致させること）。
// 先頭 11 列は従来の差込テンプレ互換（列順・列名を変えない）。
// 「部屋番号」列は所有者宛 DM の宛名印刷に使わず紛らわしいため削除した。
//   ※列削除により後続列（DM判断 以降）の位置が左にずれる点に注意
//     （列位置で差込む外注テンプレには影響・ヘッダ名ベースの差込なら影響なし）。
// グルーピング（1 送付先住所 = 1 行）後の追跡用に「送付先所有者名一覧 / 共有者数」を
// 末尾に追加する（既存テンプレへの影響を避けるため末尾追加とする）。
export const DM_EXPORT_HEADERS = [
  "管理ID",
  "物件住所",
  "所有者名",
  "敬称",
  "郵便番号",
  "所有者住所",
  "物件種別",
  "所有者名カナ",
  "代表者",
  "続柄",
  "DM判断",
  "送付先所有者名一覧",
  "共有者数",
] as const;

// 安全上限（最終 CSV 行数 = グループ（送付先）行数で判定する）。超過時は切り捨てず 400 にする。
export const MAX_DM_EXPORT_ROWS = 10000;

// 複数共有者を 1 通にまとめた行の宛名で、代表者の後ろに付ける文言。
// 正本は client/server 共有のリーフモジュール(addressee.ts)。ここでは re-export して
// 既存の import 元(dm-export)を維持しつつ、承認プレビュー等がサーバー依存を読み込まずに同整形を使える。
export { OTHER_CO_OWNERS_SUFFIX };

/**
 * maskValue が「生値」をそのまま返す表示レベルの集合。
 * permissions.ts の maskValue は edit / full / read のときのみ value を返す
 * （partial は先頭3文字+***、masked は末尾4文字、hidden は null）。
 * DM 差込は生の氏名・郵便番号・住所が必須なため、この集合に該当する場合のみ出力を許可する。
 */
export const PLAIN_OWNER_LEVELS: ReadonlySet<string> = new Set([
  "full",
  "read",
  "edit",
]);

/**
 * 表示レベルが「生値を返すレベル」かどうか。
 */
export function isPlainOwnerLevel(level: string): boolean {
  return PLAIN_OWNER_LEVELS.has(level);
}

// buildDmRow が受け取る最小限の物件・所有者の形（route の select に対応）。
export interface DmRowProperty {
  address: string | null | undefined;
  propertyType: string;
}

export interface DmRowOwner {
  name: string | null | undefined;
  nameKana: string | null | undefined;
  zip: string | null | undefined;
  address: string | null | undefined;
  corporateNumber: string | null | undefined;
}

export interface DmRowPropertyOwner {
  isPrimary: boolean;
  relationship: string | null | undefined;
  owner: DmRowOwner;
}

/**
 * グルーピング用に郵便番号を正規化する。
 *  - trim
 *  - ハイフン（半角 "-" / 全角 "－"）を除去
 *  - 内部空白（半角 / 全角 / タブ等）を除去
 * 表記揺れ（"100-0001" と "1000001"）を同一視するための比較専用の値。
 * 出力には使わず、グルーピングキーの算出にのみ使う。
 */
export function normalizeZipForGroup(
  zip: string | null | undefined,
): string {
  if (typeof zip !== "string") return "";
  return zip.replace(/[\s　\-−－]/g, "").trim();
}

/**
 * グルーピング用に住所を正規化する。
 *  - trim
 *  - 連続する空白（半角 / 全角 / タブ / 改行）を 1 つの半角空白へ畳む
 * 空白の揺れだけが異なる住所を同一視するための比較専用の値。
 * 空文字（実質「住所なし」）の場合は "" を返す。
 */
export function normalizeAddressForGroup(
  address: string | null | undefined,
): string {
  if (typeof address !== "string") return "";
  return address.replace(/[\s　]+/g, " ").trim();
}

/**
 * 「郵便番号 + 住所」のグルーピングキー。氏名は含めない。
 * zip と address の境界を NUL 区切りにし、("100" + "0001-X") と ("1000" + "001-X")
 * のような連結衝突を避ける。zip が空でも address が同じならキーは一致する
 * （空 zip 同士は同一住所なら 1 通にまとめる初期方針）。
 */
export function ownerAddressGroupKey(
  zip: string | null | undefined,
  address: string | null | undefined,
): string {
  return `${normalizeZipForGroup(zip)}\u0000${normalizeAddressForGroup(address)}`;
}

export interface OwnerAddressGroupResult {
  /** 送付先住所ごとの所有者グループ（出現順を保持）。各グループ内も入力順を保持。 */
  groups: DmRowPropertyOwner[][];
  /** address 空欄のため送付対象外として skip した所有者数。 */
  skippedAddressCount: number;
}

/**
 * 同一物件内の所有者を「郵便番号 + 住所」でグルーピングする。
 *  - Owner.address が空欄（trim 後に空）の所有者は送付先不明として skip する。
 *  - グルーピングキーに氏名は含めない（名義違いでも同住所なら 1 グループ）。
 *  - グループの出現順・グループ内の所有者順は入力順を保持する
 *    （route 側で primary 先頭・createdAt 昇順に並べてから渡す前提）。
 */
export function groupPropertyOwnersByAddress(
  propertyOwners: DmRowPropertyOwner[],
): OwnerAddressGroupResult {
  const map = new Map<string, DmRowPropertyOwner[]>();
  let skippedAddressCount = 0;

  for (const po of propertyOwners) {
    if (normalizeAddressForGroup(po.owner.address) === "") {
      skippedAddressCount += 1;
      continue;
    }
    const key = ownerAddressGroupKey(po.owner.zip, po.owner.address);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(po);
    } else {
      map.set(key, [po]);
    }
  }

  return { groups: Array.from(map.values()), skippedAddressCount };
}

/**
 * グループの代表所有者を選ぶ。primary 所有者があれば優先し、無ければ先頭（入力順）。
 */
export function selectGroupRepresentative(
  group: DmRowPropertyOwner[],
): DmRowPropertyOwner {
  return group.find((po) => po.isPrimary) ?? group[0];
}

/**
 * 1 物件 × 1 送付先グループ（1 通）を DM_EXPORT_HEADERS をキーにした 1 行へマップする。
 *  - null / undefined は空文字にする（"null" という文字列は決して出力しない）。
 *  - 宛名（所有者名 + 敬称）は代表所有者を基準にする:
 *      1 名      … 所有者名 = 代表名 / 敬称 = 御中 or 様
 *      複数名    … 所有者名 = 代表名 / 敬称 = "<代表の敬称> 他共有者様"
 *  - 郵便番号 / 所有者住所 / 氏名カナ / 続柄 / 代表者 は代表所有者の値。
 *    （グループは同一住所なので郵便番号・住所はどの所有者でも同じ）
 *  - 送付先所有者名一覧 = グループ全員の氏名を「、」で連結（追跡用・末尾列）。
 *  - 共有者数 = グループの所有者数。
 *  - 所有者名 / 郵便番号 / 所有者住所 / 氏名カナ / 一覧の各氏名は maskValue を通す。
 *  - DM判断は常に「送付可」（送付可の物件のみ出力する仕様のため）。
 */
export function buildDmRow(
  property: DmRowProperty,
  group: DmRowPropertyOwner[],
  ownerDisplayConfig: OwnerDisplayConfig,
  importSourceValue: string | null | undefined,
): Record<(typeof DM_EXPORT_HEADERS)[number], string> {
  const representative = selectGroupRepresentative(group);
  const repOwner = representative.owner;
  // DQ-05: 敬称は owner-honorific へ委譲。法人番号シグナルは旧 honorific と同式
  //（typeof string && length>0・trim しない）で算出し、法人番号あり=御中 / 個人=様 の
  // parity を保持。新たに法人番号なしの組織名（管理組合・自治会・法人格名）も御中になる。
  const hasCorporateNumber =
    typeof repOwner.corporateNumber === "string" &&
    repOwner.corporateNumber.length > 0;
  const baseHonorific = honorificForOwner(repOwner.name, hasCorporateNumber);
  const isShared = group.length > 1;

  const names = group
    .map((po) => maskValue(po.owner.name, ownerDisplayConfig.name) ?? "")
    .filter((n) => n.length > 0);

  return {
    管理ID: importSourceValue ?? "",
    物件住所: property.address ?? "",
    所有者名: maskValue(repOwner.name, ownerDisplayConfig.name) ?? "",
    敬称: isShared
      ? `${baseHonorific} ${OTHER_CO_OWNERS_SUFFIX}`
      : baseHonorific,
    郵便番号: maskValue(repOwner.zip, ownerDisplayConfig.zip) ?? "",
    所有者住所: maskValue(repOwner.address, ownerDisplayConfig.address) ?? "",
    物件種別: PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType,
    所有者名カナ: maskValue(repOwner.nameKana, ownerDisplayConfig.nameKana) ?? "",
    代表者: representative.isPrimary ? "代表" : "",
    続柄: representative.relationship ?? "",
    DM判断: DM_STATUS_LABELS["send"] ?? "送付可",
    送付先所有者名一覧: names.join("、"),
    共有者数: String(group.length),
  };
}
