import { getApiSession, getUserPermissions, getOwnerDisplayConfig, ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import prisma from "@/lib/prisma";

// キャンペーンが作成者本人のものか確認する(他人の UUID での横断アクセス=範囲外PII閲覧/改竄を防ぐ)。
// 見つからない/他人のものは同じ 404 にして存在を漏らさない。campaign を別途ロードしない route 向け。
export async function assertSaleDmCampaignOwned(campaignId: string, sessionId: string): Promise<void> {
  const owned = await prisma.dmCampaign.findFirst({
    where: { id: campaignId, createdBy: sessionId },
    select: { id: true },
  });
  if (!owned) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
}

export async function requireSaleDmAccess() {
  const session = await getApiSession();
  const permissions = await getUserPermissions(session.id);
  for (const [res, msg] of [
    ["property", "物件一覧の閲覧権限がありません"],
    ["csv_export", "CSV エクスポートの権限がありません"],
    ["csv_export_personal", "個人情報を含む出力の権限がありません"],
    ["owner", "所有者情報の閲覧権限がありません"],
  ] as const) {
    if (!hasPermission(permissions, res, "read")) throw new ApiError(403, msg, "FORBIDDEN");
  }
  const cfg = await getOwnerDisplayConfig(session.id, permissions);
  if (!isPlainOwnerLevel(cfg.name) || !isPlainOwnerLevel(cfg.zip) || !isPlainOwnerLevel(cfg.address)) {
    throw new ApiError(403, "DM作成に必要な所有者情報の表示権限がありません", "FORBIDDEN");
  }
  return { session, permissions, ownerDisplayConfig: cfg };
}
