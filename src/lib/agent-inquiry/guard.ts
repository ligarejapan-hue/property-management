import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/** 反響の受付の権限(設計 §4)。全員に既定付与・管理画面で個別に外せる。 */
export async function requireAgentInquiry(action: "read" | "write") {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "agent_inquiry", action)) {
    throw new ApiError(403, "反響の受付の権限がありません", "FORBIDDEN");
  }
  return { session, perms };
}

export const VERSION_CONFLICT_MESSAGE = "他のユーザーが先に更新しています。画面を再読み込みしてください。";
