/**
 * 物件宛DM 差込 CSV 出力の純粋ヘルパー群(route から分離し単体テスト可能にする)。
 *
 * GET /api/properties/property-dm-export が「送付可(dmStatus=send)」の物件を
 * 「1 物件 = 1 行」で物件住所宛の DM 差込 CSV に展開する際の
 * ヘッダ定義・敬称判定・表示レベル判定・郵便番号セル生成・代表者選定・行マッピングを担う。
 *
 * 送付方針(21-D タスク7):
 *  - 宛先は Property.postalCode + Property.address(物件の物理住所宛)。
 *    郵便番号は Property.postalCode → Building.postalCode → 空欄 の優先順位でフォールバックする。
 *  - 宛名は代表所有者名 + 敬称(個人=様 / 法人・法人番号なしの組織名=御中)。複数所有者は「<敬称> 他共有者様」。
 *  - 所有者の郵便番号・住所は出力しない(宛先は物件住所のため)。
 *    これにより owner zip/address の表示レベルゲートは不要(氏名のみ生値を要求)。
 *
 * 代表者選定は所有者宛DM(dm-export.ts の selectGroupRepresentative)と同一基準:
 *   primary を優先し、無ければ入力順(route で primary 先頭・createdAt 昇順に整列)の先頭。
 *
 * PII / 表示レベル:
 *  - 所有者名のみ ownerDisplayConfig + maskValue に従う。
 *  - maskValue が「生値」を返す表示レベル(full / read / edit)でのみ氏名出力を許可する想定。
 *    その判定を isPlainOwnerLevel として route 側のゲートで再利用する(氏名のみ)。
 */
import { maskValue } from "@/lib/permissions";
import { PROPERTY_TYPE_LABELS, DM_STATUS_LABELS } from "@/lib/property-types";
import { formatPostalCode, isValidPostalCode } from "@/lib/address-lookup/normalize";
import { honorificForOwner } from "@/lib/owner-honorific";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

// CSV ヘッダ(差込テンプレートの列順に厳密一致させること)。
// 宛先ブロック(郵便番号・物件住所・部屋番号)→ 宛名ブロック(所有者名・敬称)→ メタ の順。
export const PROPERTY_DM_EXPORT_HEADERS = [
  "管理ID",
  "郵便番号",
  "物件住所",
  "部屋番号",
  "所有者名",
  "敬称",
  "物件種別",
  "DM判断",
  "送付先所有者名一覧",
  "共有者数",
] as const;

// 安全上限(最終 CSV 行数 = 物件数で判定する)。超過時は切り捨てず 400 にする。
export const MAX_PROPERTY_DM_EXPORT_ROWS = 10000;

// 複数所有者を 1 通にまとめた行の宛名で、代表者の敬称の後ろに付ける文言。
export const OTHER_CO_OWNERS_SUFFIX = "他共有者様";

/**
 * maskValue が「生値」をそのまま返す表示レベルの集合(氏名ゲート用)。
 * 物件宛DM は所有者名のみ生値が必須(郵便番号・住所は物件側を使うため不要)。
 */
export const PLAIN_OWNER_LEVELS: ReadonlySet<string> = new Set(["full", "read", "edit"]);

export function isPlainOwnerLevel(level: string): boolean {
  return PLAIN_OWNER_LEVELS.has(level);
}

// buildPropertyDmRow が受け取る最小限の建物・物件・所有者の形(route の select に対応)。
export interface PropertyDmRowBuilding {
  postalCode: string | null | undefined;
}

export interface PropertyDmRowProperty {
  address: string | null | undefined;
  postalCode: string | null | undefined;
  propertyType: string;
  roomNo: string | null | undefined;
  building?: PropertyDmRowBuilding | null;
}

export interface PropertyDmRowOwner {
  name: string | null | undefined;
  corporateNumber: string | null | undefined;
}

export interface PropertyDmRowPropertyOwner {
  isPrimary: boolean;
  owner: PropertyDmRowOwner;
}

/**
 * 郵便番号の採用元を優先順位で選ぶ: Property.postalCode → Building.postalCode → 空欄。
 *  - Property.postalCode が trim 後に非空ならそれを採用(不妥当でも採用・素の値を返す)。
 *  - Property が null/空/空白のみのときだけ Building.postalCode を参照する。
 *  - 両方 null/空なら空文字。
 * 整形(NNN-NNNN)は toPropertyDmPostalCell が行う。ここでは採用元の生値を返す。
 */
export function pickPropertyDmPostalSource(
  propertyPostalCode: string | null | undefined,
  buildingPostalCode: string | null | undefined,
): string {
  if (typeof propertyPostalCode === "string" && propertyPostalCode.trim() !== "") {
    return propertyPostalCode;
  }
  if (typeof buildingPostalCode === "string" && buildingPostalCode.trim() !== "") {
    return buildingPostalCode;
  }
  return "";
}

/**
 * 郵便番号セル値を生成する。
 *  - 採用元(pickPropertyDmPostalSource)が妥当な7桁なら NNN-NNNN へ整形。
 *  - 不妥当(7桁でない)なら素のまま返す(勝手に変形しない)。
 *  - 採用元が空なら空文字。
 * #170(物件CSV export)の toPostalCodeCell と同じ整形方針(妥当→整形 / 不妥当→素 / 空→空)。
 */
export function toPropertyDmPostalCell(
  propertyPostalCode: string | null | undefined,
  buildingPostalCode: string | null | undefined,
): string {
  const src = pickPropertyDmPostalSource(propertyPostalCode, buildingPostalCode);
  if (src === "") return "";
  return isValidPostalCode(src) ? formatPostalCode(src) : src;
}

/**
 * 代表所有者を選ぶ。primary 所有者があれば優先し、無ければ先頭(入力順)。
 * 所有者宛DM(dm-export.ts の selectGroupRepresentative)と同一基準。
 * route 側で primary 先頭・createdAt 昇順に並べてから渡す前提(owners は非空)。
 */
export function selectRepresentative(
  owners: PropertyDmRowPropertyOwner[],
): PropertyDmRowPropertyOwner {
  return owners.find((po) => po.isPrimary) ?? owners[0];
}

/**
 * 1 物件 = 1 行(物件住所宛 1 通)を PROPERTY_DM_EXPORT_HEADERS をキーにした 1 行へマップする。
 *  - null / undefined は空文字にする(literal "null" は出力しない)。
 *  - 宛名(所有者名 + 敬称)は代表所有者を基準にする:
 *      1 名   … 所有者名 = 代表名 / 敬称 = 御中 or 様
 *      複数名 … 所有者名 = 代表名 / 敬称 = "<代表の敬称> 他共有者様"
 *  - 郵便番号は物件(→建物)由来。所有者の郵便番号・住所は出力しない。
 *  - 送付先所有者名一覧 = 全(非アーカイブ)所有者名を「、」連結。
 *  - 共有者数 = 物件の(非アーカイブ)所有者数。
 *  - 所有者名 / 一覧の各氏名は maskValue を通す。
 *  - DM判断は常に「送付可」(送付可の物件のみ出力する仕様のため)。
 */
export function buildPropertyDmRow(
  property: PropertyDmRowProperty,
  owners: PropertyDmRowPropertyOwner[],
  ownerDisplayConfig: OwnerDisplayConfig,
  importSourceValue: string | null | undefined,
): Record<(typeof PROPERTY_DM_EXPORT_HEADERS)[number], string> {
  const representative = selectRepresentative(owners);
  const repOwner = representative.owner;
  // DQ-05: 敬称は owner-honorific へ委譲（所有者宛 dm-export.ts と同方針）。法人番号シグナルは
  // 旧 honorific と同式（typeof string && length>0・trim しない）で算出し parity を保持。
  // 法人番号なしの組織名（管理組合・自治会・法人格名）も名称ベースで御中になる。
  const hasCorporateNumber =
    typeof repOwner.corporateNumber === "string" &&
    repOwner.corporateNumber.length > 0;
  const baseHonorific = honorificForOwner(repOwner.name, hasCorporateNumber);
  const isShared = owners.length > 1;

  const names = owners
    .map((po) => maskValue(po.owner.name, ownerDisplayConfig.name) ?? "")
    .filter((n) => n.length > 0);

  return {
    管理ID: importSourceValue ?? "",
    郵便番号: toPropertyDmPostalCell(property.postalCode, property.building?.postalCode),
    物件住所: property.address ?? "",
    部屋番号: property.roomNo ?? "",
    所有者名: maskValue(repOwner.name, ownerDisplayConfig.name) ?? "",
    敬称: isShared ? `${baseHonorific} ${OTHER_CO_OWNERS_SUFFIX}` : baseHonorific,
    物件種別: PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType,
    DM判断: DM_STATUS_LABELS["send"] ?? "送付可",
    送付先所有者名一覧: names.join("、"),
    共有者数: String(owners.length),
  };
}
