import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { escapePrismaLikePattern, extractStorageKeyFromFileUrl } from "@/lib/uploads-authorization";

/** 一般書類の保持期間（日）。謄本(type="registry")は対象外＝自動削除しない。 */
export const ATTACHMENT_RETENTION_DAYS = 90;

export interface PurgeResult {
  scanned: number;
  purged: number;
  failed: number;   // storage delete failed → DB row kept for retry (NOT counted as purged)
  skipped: number;  // no longer eligible at delete time (restored / concurrently purged)
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
 * storage key が他の upload-backed レコードからまだ参照されているか。
 * /uploads namespace は attachment と PropertyPhoto / BuildingPhoto /
 * FieldSurveyPinPhoto が共有し、caller-supplied fileUrl で key 共有が起こり得る
 * （uploads-authorization が同 4 テーブルを参照として扱うのと同じ前提）。
 * いずれかがまだ参照していれば実体を消してはならない。authz 層と同じく
 * contains（LIKE はエスケープ）で粗く絞り、JS 側で extractStorageKeyFromFileUrl の
 * 完全一致で判定する。※ 参照テーブル集合は uploads-authorization と一致させること。
 * purge チェックは全フォトテーブル（PropertyPhoto / BuildingPhoto / FieldSurveyPinPhoto）で
 * fileUrl AND thumbnailUrl の両列を確認する（authz の fileUrl-only より広いスーパーセット）。
 * オブジェクトを物理削除するため、サムネイル参照も含むすべての参照を検出しなければならない。
 *
 * excludeAttachmentId: storage-first フローでは DB 行を先に消さないため、
 * purge 対象行自身の fileUrl が attachment クエリにヒットして常に参照あり判定になる。
 * 自身の行を除外するためにこの引数を渡す（photo テーブルは対象外・変更なし）。
 */
async function isStorageKeyStillReferenced(
  key: string,
  excludeAttachmentId?: string,
): Promise<boolean> {
  const escaped = escapePrismaLikePattern(key);
  const matchesKey = (fileUrl: string | null | undefined) =>
    extractStorageKeyFromFileUrl(fileUrl) === key;

  const attachments = await prisma.attachment.findMany({
    where: {
      fileUrl: { contains: escaped },
      ...(excludeAttachmentId ? { id: { not: excludeAttachmentId } } : {}),
    },
    select: { fileUrl: true },
  });
  if (attachments.some((a) => matchesKey(a.fileUrl))) return true;

  const propertyPhotos = await prisma.propertyPhoto.findMany({
    where: {
      OR: [
        { fileUrl: { contains: escaped } },
        { thumbnailUrl: { contains: escaped } },
      ],
    },
    select: { fileUrl: true, thumbnailUrl: true },
  });
  if (propertyPhotos.some((p) => matchesKey(p.fileUrl) || matchesKey(p.thumbnailUrl))) return true;

  const buildingPhotos = await prisma.buildingPhoto.findMany({
    where: {
      OR: [
        { fileUrl: { contains: escaped } },
        { thumbnailUrl: { contains: escaped } },
      ],
    },
    select: { fileUrl: true, thumbnailUrl: true },
  });
  if (buildingPhotos.some((b) => matchesKey(b.fileUrl) || matchesKey(b.thumbnailUrl))) return true;

  const pinPhotos = await prisma.fieldSurveyPinPhoto.findMany({
    where: {
      OR: [
        { fileUrl: { contains: escaped } },
        { thumbnailUrl: { contains: escaped } },
      ],
    },
    select: { fileUrl: true, thumbnailUrl: true },
  });
  if (pinPhotos.some((pp) => matchesKey(pp.fileUrl) || matchesKey(pp.thumbnailUrl))) return true;

  return false;
}

/**
 * 猶予超過の一般添付を物理削除する。storage-first: blob を先に消してから DB 行を削除。
 * - dryRun: 件数のみ（storage/DB 不変）。
 * - 各行は削除直前に再確認（復元/並行 purge レースを最小化）。適格外なら skipped。
 * - storage 実体は、他行が同一 key を参照していない場合のみ削除（共有 object 保護）。
 *   自身の行は参照チェックから除外（storage-first では DB 行がまだ存在するため）。
 * - storage 削除失敗: DB 行を保持し次回 cleanup で再試行可能にする（failed カウント）。
 *   key/err は PII を含み得るためログ・レスポンスに出力しない（件数のみ集計）。
 * - DB 行削除は storage 成功後のみ（または storage 不要の場合）。deleteMany で race ガード。
 */
export async function purgeExpiredAttachments(opts: {
  now: Date;
  limit: number;
  dryRun?: boolean;
}): Promise<PurgeResult> {
  const cutoff = purgeableCutoff(opts.now);
  const rows = await findPurgeableAttachments(opts.now, opts.limit);
  if (opts.dryRun) {
    return { scanned: rows.length, purged: 0, failed: 0, skipped: 0 };
  }

  let purged = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    // 削除直前に現在の適格性を再確認（選択〜削除間の復元/並行 purge レースを最小化）。
    const current = await prisma.attachment.findUnique({
      where: { id: row.id },
      select: { isDeleted: true, type: true, deletedAt: true, fileUrl: true },
    });
    if (
      !current ||
      !current.isDeleted ||
      current.type === "registry" ||
      current.deletedAt === null ||
      current.deletedAt > cutoff
    ) {
      skipped++;
      continue;
    }

    // storage を先に削除（自前 key かつ他行が参照していない場合のみ。自身の行は除外）。
    const key = extractStorageKeyFromFileUrl(current.fileUrl);
    if (key && !(await isStorageKeyStillReferenced(key, row.id))) {
      try {
        await getStorage().delete(key);
      } catch {
        // storage 削除失敗: DB 行は残し次回 cleanup で再試行可能にする。成功扱いにしない。
        // key/err は PII を含み得るためログ・レスポンスに出さない（件数のみ集計）。
        failed++;
        continue;
      }
    }

    // storage 成功（または共有 key / 非 storage URL）後にのみ DB 行を削除。
    // 同じ適格条件を再指定し、race で条件が変わった行は消さない。
    const { count } = await prisma.attachment.deleteMany({
      where: {
        id: row.id,
        isDeleted: true,
        type: { not: "registry" },
        deletedAt: { not: null, lte: cutoff },
      },
    });
    if (count === 0) {
      skipped++;
      continue;
    }
    purged++;
  }

  return { scanned: rows.length, purged, failed, skipped };
}
