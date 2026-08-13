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

// field_staff は現在の物件 record scope(作成 or 担当)の宛先のみ可視にする。物件が別担当へ
// 再割当されたら、自分が作成したキャンペーンでもその宛先PII(氏名/住所/本文)を出さない。
// 非 field_staff(admin/office)は全件。GET campaign / CSV出力 / 印刷 で共通利用する。
export function filterDraftsByFieldStaffScope<
  T extends { property: { createdBy: string | null; assignedTo: string | null } },
>(drafts: T[], session: { id: string; role?: string | null }): T[] {
  if (session.role !== "field_staff") return drafts;
  return drafts.filter(
    (d) => d.property.createdBy === session.id || d.property.assignedTo === session.id,
  );
}

// 書き込み系（キャンペーン作成・型の作成/更新/削除・割当・確定・下書き編集・再生成）の共通門。
// これまでの実質的な門は sale_dm:generate（生成できなければ何も作れない）だったが、
// 外部AI方式では生成なしで一式が作れるため、閲覧権限だけの利用者が記録の作成・失効・
// 確定までできてしまう。同じ結果を生む全経路に同じ門を置く（設計 §2.5）。
export async function requireSaleDmWriteAccess() {
  const ctx = await requireSaleDmAccess();
  if (!hasPermission(ctx.permissions, "property", "write")) {
    throw new ApiError(403, "物件情報の編集権限がありません", "FORBIDDEN");
  }
  return ctx;
}
