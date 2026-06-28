export const dmUndeliverableBadgeLabel = "宛先不明";

export function isDmUndeliverable(
  dmUndeliverableAt: string | null | undefined,
): boolean {
  return typeof dmUndeliverableAt === "string" && dmUndeliverableAt.length > 0;
}

type PermissionLike = { resource: string; action: string; granted: boolean };

// 売却DM作成の表示可否。csv_export + csv_export_personal + owner の read に加え、
// 有料AI生成の専用権限 sale_dm:generate(action=generate)も要求する。
// これが無いと作成ボタンを押しても server(campaigns POST)が 403 にするため、UI でも非表示にし
// 「押せるのに実行できない」操作を見せない。permissions=null(未取得・取得失敗)は fail-safe で false。
export function canCreateSaleDm(perms: PermissionLike[] | null): boolean {
  if (!perms) return false;
  const has = (resource: string) =>
    perms.some((p) => p.resource === resource && p.action === "read" && p.granted);
  const canGenerate = perms.some((p) => p.resource === "sale_dm" && p.action === "generate" && p.granted);
  return has("csv_export") && has("csv_export_personal") && has("owner") && canGenerate;
}
