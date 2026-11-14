/**
 * 所有者が入っていない物件は手で「送付可」にできない(2026-11-14 発注者決定)。
 * 所有者が入ると、見回り(sweeper.ts)が DM判断を自動で仕分ける。
 * 入口: ワンタッチの DM判断・一覧のまとめて変更・物件の編集(PATCH)。
 */

import { ApiError } from "@/lib/api-helpers";

export const NO_OWNER_DM_SEND_MESSAGE =
  "所有者が入っていない物件は「送付可」にできません。所有者が入ると、DM判断は自動で仕分けます";

export async function assertOwnersForDmSend(
  db: { property: { count(args: { where: { id: { in: string[] }; propertyOwners: { none: object } } }): Promise<number> } },
  propertyIds: readonly string[],
): Promise<void> {
  if (propertyIds.length === 0) return;
  const n = await db.property.count({ where: { id: { in: [...propertyIds] }, propertyOwners: { none: {} } } });
  if (n > 0) throw new ApiError(422, NO_OWNER_DM_SEND_MESSAGE, "NO_OWNER_DM_SEND");
}
