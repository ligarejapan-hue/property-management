import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { extractStorageKeyFromUrl } from "@/lib/storage/url-to-key";

/** 一般書類の保持期間（日）。謄本(type="registry")は対象外＝自動削除しない。 */
export const ATTACHMENT_RETENTION_DAYS = 90;

export interface PurgeResult {
  scanned: number;
  purged: number;
}

/** now から retentionDays 日前（この時刻以前に削除された行が purge 対象）。 */
export function purgeableCutoff(
  now: Date,
  retentionDays: number = ATTACHMENT_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/** purge 対象（soft-delete 済み・謄本以外・猶予超過）を最大 limit 件。 */
export async function findPurgeableAttachments(now: Date, limit: number) {
  return prisma.attachment.findMany({
    where: {
      isDeleted: true,
      type: { not: "registry" }, // 謄本は自動削除しない
      deletedAt: { not: null, lte: purgeableCutoff(now) },
    },
    select: { id: true, fileUrl: true },
    orderBy: { deletedAt: "asc" },
    take: limit,
  });
}

/**
 * 猶予超過の一般添付を物理削除する。
 * - dryRun: 件数のみ（storage/DB 不変）。
 * - 自前 storage key のみ storage.delete（冪等）。外部/不正 URL は storage を触らず行だけ削除。
 */
export async function purgeExpiredAttachments(opts: {
  now: Date;
  limit: number;
  dryRun?: boolean;
}): Promise<PurgeResult> {
  const rows = await findPurgeableAttachments(opts.now, opts.limit);
  if (opts.dryRun) return { scanned: rows.length, purged: 0 };

  let purged = 0;
  for (const row of rows) {
    const key = extractStorageKeyFromUrl(row.fileUrl);
    if (key) {
      await getStorage().delete(key); // 冪等（404/NoSuchKey は握りつぶし）
    }
    await prisma.attachment.delete({ where: { id: row.id } });
    purged++;
  }
  return { scanned: rows.length, purged };
}
