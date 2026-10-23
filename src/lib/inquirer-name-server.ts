/**
 * 問い合わせ者(Property.inquirerName)を返すときの「見る人の表示レベル」を決める(サーバー専用)。
 * owner:read が無ければ null(=キーごと出さない)。ある人は所有者の氏名と同じ表示レベル。
 */
import { getOwnerDisplayConfig, type PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

export async function inquirerNameLevelFor(
  userId: string,
  permissions: PermissionEntry[],
): Promise<string | null> {
  if (!hasPermission(permissions, "owner", "read")) return null;
  const cfg = await getOwnerDisplayConfig(userId, permissions);
  return cfg.name;
}
