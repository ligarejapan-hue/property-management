import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";

/** 反響に付ける名簿の業者があり、しまわれていないか(登録・付け替えで共通)。 */
export async function assertAgentSelectable(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, isArchived: true } });
  if (!agent) throw new ApiError(404, "業者が見つかりません", "AGENT_NOT_FOUND");
  if (agent.isArchived) {
    throw new ApiError(409, "この業者はしまわれています。名簿で戻してから選んでください", "AGENT_ARCHIVED");
  }
}
