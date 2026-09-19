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

// 売却DMを使うために必要な4権限(read)。requireSaleDmAccess / checkSaleDmAccessFor で共有する。
const SALE_DM_REQUIRED_READS = [
  ["property", "物件一覧の閲覧権限がありません"],
  ["csv_export", "CSV エクスポートの権限がありません"],
  ["csv_export_personal", "個人情報を含む出力の権限がありません"],
  ["owner", "所有者情報の閲覧権限がありません"],
] as const;

export type SaleDmAccessCheck =
  | {
      ok: true;
      permissions: Awaited<ReturnType<typeof getUserPermissions>>;
      ownerDisplayConfig: Awaited<ReturnType<typeof getOwnerDisplayConfig>>;
    }
  | { ok: false; reason: "permission" | "display" };

// 任意の利用者(ログイン中の本人とは限らない)が売却DMを使えるかを判定する。
// 通知の宛先判定など、セッションを持たない利用者に対しても呼べるように requireSaleDmAccess
// から条件だけを切り出したもの。判定条件は requireSaleDmAccess と完全に同一だが、
// こちらは例外を投げず ok/reason で結果を返す(候補者を1人ずつ判定するため 403 で
// 処理全体を止めるわけにいかない)。
export async function checkSaleDmAccessFor(userId: string): Promise<SaleDmAccessCheck> {
  const permissions = await getUserPermissions(userId);
  for (const [res] of SALE_DM_REQUIRED_READS) {
    if (!hasPermission(permissions, res, "read")) return { ok: false, reason: "permission" };
  }
  const cfg = await getOwnerDisplayConfig(userId, permissions);
  if (!isPlainOwnerLevel(cfg.name) || !isPlainOwnerLevel(cfg.zip) || !isPlainOwnerLevel(cfg.address)) {
    return { ok: false, reason: "display" };
  }
  return { ok: true, permissions, ownerDisplayConfig: cfg };
}

export async function requireSaleDmAccess() {
  const session = await getApiSession();
  const permissions = await getUserPermissions(session.id);
  for (const [res, msg] of SALE_DM_REQUIRED_READS) {
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
