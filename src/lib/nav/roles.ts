/** アプリの役割(prisma Role enum と対応)。 */
export type AppRole = "field_staff" | "office_staff" | "admin";

/** 役割の可視レベル。数が大きいほど広く見える。 */
export const ROLE_LEVEL: Record<AppRole, number> = {
  field_staff: 1,
  office_staff: 2,
  admin: 3,
};

/**
 * セッションの role 文字列 → 可視レベル。大文字小文字は無視する。
 * 未知・未設定(旧 VIEWER 等、正規の role が無い)は最も制限的な field_staff 相当(1)に
 * フォールバック=余計なものを出さない安全側。
 */
export function roleLevel(role?: string | null): number {
  const key = (role ?? "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ROLE_LEVEL, key)) {
    return ROLE_LEVEL[key as AppRole];
  }
  return ROLE_LEVEL.field_staff;
}

/** userRole が minRole 以上か(その項目を見せてよいか)。 */
export function canSee(userRole: string | null | undefined, minRole: AppRole): boolean {
  return roleLevel(userRole) >= ROLE_LEVEL[minRole];
}
