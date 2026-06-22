export const dmUndeliverableBadgeLabel = "宛先不明";

export function isDmUndeliverable(
  dmUndeliverableAt: string | null | undefined,
): boolean {
  return typeof dmUndeliverableAt === "string" && dmUndeliverableAt.length > 0;
}

type PermissionLike = { resource: string; action: string; granted: boolean };

// 売却DM作成の表示可否。既存 canExportDm と同条件
// (csv_export + csv_export_personal + owner の read)。
// permissions=null(未取得・取得失敗)は fail-safe で false。
export function canCreateSaleDm(perms: PermissionLike[] | null): boolean {
  if (!perms) return false;
  const has = (resource: string) =>
    perms.some((p) => p.resource === resource && p.action === "read" && p.granted);
  return has("csv_export") && has("csv_export_personal") && has("owner");
}
