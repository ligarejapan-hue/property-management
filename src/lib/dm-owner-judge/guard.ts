/**
 * 所有者が入っていない物件は手で「送付可」にできない(2026-11-14 発注者決定)。
 * 所有者が入ると、見回り(sweeper.ts)が DM判断を自動で仕分ける。
 * 入口: ワンタッチの DM判断・一覧のまとめて変更・物件の編集(PATCH)。
 */

import { ApiError } from "@/lib/api-helpers";
import {
  findPropertiesWithAgentNameOwners,
  type AgentNameExclusionTx,
} from "@/lib/dm-batch/agent-name-exclusion";

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

export const AGENT_NAME_DM_SEND_MESSAGE =
  "業者の名簿と同じ名前の所有者か、自治体・国が持ち主の物件は「送付可」にできません(DM は送付不可です)";

/**
 * 業者の名簿(国交省の業者一覧を含む)と同じ名前の所有者がいる物件は、手で「送付可」にできない
 * (2026-11-16 発注者「業者の名簿と同一名は DM 送付不可」)。判定は DM の作成と同じ(agent-name-exclusion.ts)。
 * 2026-11-24: 名前が自治体・国の所有者がいる物件も同じく「送付可」にできない(public-owner-name.ts)。
 * 入口: ワンタッチの DM判断・一覧のまとめて変更・物件の編集(PATCH)。
 */
export async function assertNoAgentNameOwnersForDmSend(
  db: AgentNameExclusionTx,
  propertyIds: readonly string[],
): Promise<void> {
  if (propertyIds.length === 0) return;
  const hit = await findPropertiesWithAgentNameOwners(db, propertyIds);
  if (hit.size > 0) throw new ApiError(422, AGENT_NAME_DM_SEND_MESSAGE, "AGENT_NAME_DM_SEND");
}
