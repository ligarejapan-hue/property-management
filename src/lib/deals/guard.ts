import { ApiError, getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

/** 取引の権限(設計 §2.6)。全員に既定付与・管理画面で個別に外せる。 */
export async function requireDeal(action: "read" | "write") {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "deal", action)) {
    throw new ApiError(403, "取引の権限がありません", "FORBIDDEN");
  }
  return { session, perms };
}

/** 取引の設定・税率の表は管理者だけ(会社情報の設定と同じ判定)。 */
export async function requireDealAdmin() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  if (!hasPermission(perms, "user_management", "write")) {
    throw new ApiError(403, "取引の設定を変更する権限がありません(管理者のみ)", "FORBIDDEN");
  }
  return session;
}

export const DEAL_VERSION_CONFLICT_MESSAGE = "ほかの人が先に更新しました。画面を読み込み直してください。";
