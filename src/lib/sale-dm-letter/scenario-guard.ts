import type { Prisma } from "@/generated/prisma";
import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { checkSaleDmAccessFor } from "@/lib/sale-dm-letter/route-guard";

/** 台帳の中身の読み書き=管理者だけ(設計 §3.6)。 */
export async function requireScenarioAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "DMの種類の編集は管理者のみ行えます", "FORBIDDEN");
  }
  return { session };
}

/** 種類の選択肢=物件を編集できる人(物件の欄)か売却DMを使える人(発送の既定)。中身は返さない。 */
export async function requireScenarioOptionsAccess() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (hasPermission(perms, "property", "write")) return { session };
  const dm = await checkSaleDmAccessFor(session.id);
  if (dm.ok) return { session };
  throw new ApiError(403, "権限がありません", "FORBIDDEN");
}

export const SCENARIO_OPTION_SELECT = { id: true, name: true, sortOrder: true, autoKey: true } as const;

/** 台帳を書き換える経路は必ず最初にこれ(設計 §3.3.1)。削除済みは 404。 */
export async function lockScenarioForUpdate(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string; deleted_at: Date | null }>>`
    SELECT id, deleted_at FROM dm_scenarios WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0 || rows[0].deleted_at) {
    throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
  }
}

/** 台帳を読むだけの経路(物件の欄の保存など)。書く側の FOR UPDATE とだけ直列になる。 */
export async function lockScenarioForShare(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string; active: boolean; deletedAt: Date | null } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; active: boolean; deleted_at: Date | null }>>`
    SELECT id, active, deleted_at FROM dm_scenarios WHERE id = ${id}::uuid FOR SHARE`;
  return rows[0] ? { id: rows[0].id, active: rows[0].active, deletedAt: rows[0].deleted_at } : null;
}
