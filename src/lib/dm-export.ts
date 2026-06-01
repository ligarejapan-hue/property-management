/**
 * DM 差込 CSV 出力の純粋ヘルパー群（route から分離し単体テスト可能にする）。
 *
 * GET /api/properties/dm-export が「送付可（dmStatus=send）」の物件を所有者 1 名 = 1 行で
 * 差込用 CSV に展開する際のヘッダ定義・敬称判定・表示レベル判定・行マッピングを担う。
 *
 * PII / 表示レベル:
 *  - 所有者名 / 郵便番号 / 住所 / 氏名カナは ownerDisplayConfig + maskValue に従う。
 *  - maskValue が「生値」を返す表示レベル（full / read / edit）でのみ DM 出力を許可する想定。
 *    その判定を isPlainOwnerLevel として route 側のゲートで再利用する。
 */
import { maskValue } from "@/lib/permissions";
import { PROPERTY_TYPE_LABELS, DM_STATUS_LABELS } from "@/lib/property-types";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

// CSV ヘッダ（差込テンプレートの列順に厳密一致させること）。
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
  "部屋番号",
  "DM判断",
] as const;

// 安全上限（最終 CSV 行数 = 所有者行数で判定する）。超過時は切り捨てず 400 にする。
export const MAX_DM_EXPORT_ROWS = 10000;

/**
 * 敬称を返す。法人番号が非空文字列なら法人とみなして「御中」、それ以外は「様」。
 */
export function honorific(corporateNumber: string | null | undefined): string {
  return typeof corporateNumber === "string" && corporateNumber.length > 0
    ? "御中"
    : "様";
}

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
  roomNo: string | null | undefined;
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
 * 1 物件 × 1 所有者を DM_EXPORT_HEADERS をキーにした 1 行へマップする。
 *  - null / undefined は空文字にする（"null" という文字列は決して出力しない）。
 *  - 所有者名 / 郵便番号 / 所有者住所 / 氏名カナは maskValue を通す。
 *  - 敬称は法人番号の有無で 御中 / 様 を出し分ける。
 *  - DM判断は常に「送付可」（送付可の物件のみ出力する仕様のため）。
 */
export function buildDmRow(
  property: DmRowProperty,
  propertyOwner: DmRowPropertyOwner,
  ownerDisplayConfig: OwnerDisplayConfig,
  importSourceValue: string | null | undefined,
): Record<(typeof DM_EXPORT_HEADERS)[number], string> {
  const owner = propertyOwner.owner;
  return {
    管理ID: importSourceValue ?? "",
    物件住所: property.address ?? "",
    所有者名: maskValue(owner.name, ownerDisplayConfig.name) ?? "",
    敬称: honorific(owner.corporateNumber),
    郵便番号: maskValue(owner.zip, ownerDisplayConfig.zip) ?? "",
    所有者住所: maskValue(owner.address, ownerDisplayConfig.address) ?? "",
    物件種別: PROPERTY_TYPE_LABELS[property.propertyType] ?? property.propertyType,
    所有者名カナ: maskValue(owner.nameKana, ownerDisplayConfig.nameKana) ?? "",
    代表者: propertyOwner.isPrimary ? "代表" : "",
    続柄: propertyOwner.relationship ?? "",
    部屋番号: property.roomNo ?? "",
    DM判断: DM_STATUS_LABELS["send"] ?? "送付可",
  };
}
