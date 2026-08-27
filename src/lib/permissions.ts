import type { PermissionEntry } from "@/lib/api-helpers";

/**
 * PermissionMap is an alias for PermissionEntry[] used by display-level module.
 */
export type PermissionMap = PermissionEntry[];

/**
 * Check if the given permissions grant access to a resource+action.
 * Defaults to deny if no matching entry is found.
 */
export function hasPermission(
  permissions: PermissionEntry[],
  resource: string,
  action: string,
): boolean {
  const entry = permissions.find(
    (p) => p.resource === resource && p.action === action,
  );
  return entry?.granted ?? false;
}

/**
 * Returns true if the user has an **explicit** full or edit permission for the given resource.
 * Unlike getOwnerDisplayConfig (which has an owner_email → owner_phone fallback for display),
 * this function does NOT fall back. Use this for write permission gates only.
 */
export function hasExplicitWritePerm(permissions: PermissionEntry[], resource: string): boolean {
  return permissions.some(
    (p) => p.resource === resource && p.granted && (p.action === "full" || p.action === "edit"),
  );
}

/**
 * Get the highest-level display permission for an owner field.
 * Returns: "full" | "read" | "partial" | "masked" | "hidden"
 */
export function getOwnerFieldLevel(
  permissions: PermissionEntry[],
  fieldResource: string,
): string {
  // Priority: edit > full > read > partial > masked > hidden
  const levels = ["edit", "full", "read", "partial", "masked", "hidden"];
  for (const level of levels) {
    const entry = permissions.find(
      (p) => p.resource === fieldResource && p.action === level,
    );
    if (entry?.granted) return level;
  }
  return "hidden";
}

/**
 * Mask a value based on display level.
 */
export function maskValue(
  value: string | null | undefined,
  level: string,
): string | null {
  if (!value) return null;

  switch (level) {
    case "edit":
    case "full":
    case "read":
      return value;
    case "partial":
      // Show first 3 chars + ***
      return value.length > 3 ? value.substring(0, 3) + "***" : value;
    case "masked":
      // Show last 4 chars, mask rest
      if (value.length <= 4) return "****";
      return "***" + value.substring(value.length - 4);
    case "hidden":
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 表示レベルの共有ロジック（@codex PR#414 17巡目 ①）
//
// ⚠**「マスク無しで見える」レベルの集合を発明しない**。`maskValue` の実装を
//   実際に叩いて、値が**そのまま返るレベルだけ**を採る。閾値を手で書くと、
//   maskValue 側が変わったときに静かに食い違う（一番危険な形）。
// ---------------------------------------------------------------------------

/** 表示レベルの全種類（強い順）。 */
export const OWNER_DISPLAY_LEVELS: readonly string[] = [
  "edit",
  "full",
  "read",
  "partial",
  "masked",
  "hidden",
];

/**
 * `maskValue` が**値をそのまま返す**レベルの集合（実測で決める）。
 * 探り値は partial(先頭3文字+***) と masked(***+末尾4文字) の両方で必ず変わる長さにする。
 */
export const MASK_FREE_DISPLAY_LEVELS: ReadonlySet<string> = (() => {
  const probe = "ABCDEFGHIJ";
  return new Set(
    OWNER_DISPLAY_LEVELS.filter((level) => maskValue(probe, level) === probe),
  );
})();

/** その表示レベルなら生値が見えるか（＝マスクが掛からないか）。 */
export function isMaskFreeLevel(level: string): boolean {
  return MASK_FREE_DISPLAY_LEVELS.has(level);
}

export interface OwnerDisplayConfigShape {
  name: string;
  nameKana: string;
  phone: string;
  zip: string;
  address: string;
  note: string;
  email: string;
  corporateNumber: string;
}

/**
 * owner 各フィールドの表示レベルを**権限配列だけから**解決する純関数。
 *
 * ⚠`getOwnerDisplayConfig`（@/lib/api-helpers）の中身をここへ移したもの。
 *   api-helpers は next-auth を読み込むため、権限判定だけを使いたい場所
 *   （uploads-authorization など）から呼べない。**実装は1本**にして、
 *   api-helpers 側はこれを呼ぶだけにしてある（二重管理で食い違わせない）。
 */
export function resolveOwnerDisplayConfig(
  permissions: PermissionEntry[],
): OwnerDisplayConfigShape {
  const resolveLevel = (field: string): string =>
    getOwnerFieldLevel(permissions, field);

  // owner_email が権限テンプレートに明示設定されていない場合は owner_phone に
  // フォールバック（seed 実行前の既存本番テンプレートで email が意図せず hidden に
  // ならないようにする既存挙動）。
  const hasExplicitEmailEntry = permissions.some((p) => p.resource === "owner_email");
  const emailLevel = hasExplicitEmailEntry
    ? resolveLevel("owner_email")
    : resolveLevel("owner_phone");

  const hasExplicitCorporateNumberEntry = permissions.some(
    (p) => p.resource === "owner_corporate_number",
  );
  const corporateNumberLevel = hasExplicitCorporateNumberEntry
    ? resolveLevel("owner_corporate_number")
    : resolveLevel("owner_name");

  return {
    name: resolveLevel("owner_name"),
    nameKana: resolveLevel("owner_name_kana"),
    phone: resolveLevel("owner_phone"),
    zip: resolveLevel("owner_zip"),
    address: resolveLevel("owner_address"),
    note: resolveLevel("owner_note"),
    email: emailLevel,
    corporateNumber: corporateNumberLevel,
  };
}
