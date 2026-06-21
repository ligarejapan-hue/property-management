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

/**
 * purge 対象（soft-delete 済み・謄本以外・猶予超過・未 claimed）を最大 limit 件。
 * purgeStartedAt: null を条件に含めることで、クラッシュ等で stale になった claim 済み行を
 * 除外し、batch スロットを新規 eligible 行に確保する（stale-claim starvation 防止）。
 * 行ごとの claim updateMany と finalize deleteMany の各ガードは別途維持。
 */
export async function findPurgeableAttachments(now: Date, limit: number) {
  return prisma.attachment.findMany({
    where: {
      isDeleted: true,
      type: { not: "registry" }, // 謄本は自動削除しない
      deletedAt: { not: null, lte: purgeableCutoff(now) },
      purgeStartedAt: null, // 既に claim 済み(stale含む)は除外 → batch を専有して新規を starve させない
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
 * excludeAttachmentId: 2-phase claim フローでは DB 行を先に消さないため、
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
 * 猶予超過の一般添付を物理削除する。2-phase claim: purgeStartedAt マーカーで
 * purge と restore を DB レベルで相互排他にする。
 *
 * フロー（行ごと）:
 *   1. CLAIM: updateMany で purgeStartedAt をセット（まだ eligible かつ未 claimed の行のみ）。
 *      count=0 なら restore 済み／並行 claimed → skipped。
 *   2. STORAGE DELETE: blob を先に削除（claimed 行はもう restore 不可）。
 *      自身の行は参照チェックから除外。storage 失敗なら RELEASE（purgeStartedAt を null 戻し）
 *      → failed。key/err は PII を含み得るためログ・レスポンスに出さない（件数のみ集計）。
 *   3. FINALIZE: deleteMany で DB 行を削除（purgeStartedAt:{not:null} ガード込み）。
 *      count=0 は defensive skip。
 *
 * dryRun: 件数のみ（storage/DB 不変）。
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
    // (1) Atomically CLAIM: set the marker only if still eligible AND not already claimed.
    //     Mutually exclusive with restore (which only un-deletes when purgeStartedAt is null).
    const claim = await prisma.attachment.updateMany({
      where: {
        id: row.id,
        isDeleted: true,
        type: { not: "registry" },
        deletedAt: { not: null, lte: cutoff },
        purgeStartedAt: null,
      },
      data: { purgeStartedAt: opts.now },
    });
    if (claim.count === 0) {
      skipped++; // restored / changed / already claimed by a concurrent run
      continue;
    }

    // (2) Delete the storage object first (claimed row can no longer be restored).
    //     Only our own self-excluded key, and only if no other row references it.
    const key = extractStorageKeyFromFileUrl(row.fileUrl);
    if (key && !(await isStorageKeyStillReferenced(key, row.id))) {
      try {
        await getStorage().delete(key);
      } catch {
        // Storage failed → RELEASE the claim so the row is retried next run. Not counted as purged.
        // key/err can contain PII → never logged; only counts are aggregated.
        await prisma.attachment.updateMany({
          where: { id: row.id },
          data: { purgeStartedAt: null },
        });
        failed++;
        continue;
      }
    }

    // (3) Finalize: delete the claimed DB row (re-specify the guard incl. purgeStartedAt not null).
    const del = await prisma.attachment.deleteMany({
      where: {
        id: row.id,
        isDeleted: true,
        type: { not: "registry" },
        deletedAt: { not: null, lte: cutoff },
        purgeStartedAt: { not: null },
      },
    });
    if (del.count === 0) {
      skipped++; // defensive: should not happen since we own the claim
      continue;
    }
    purged++;
  }

  return { scanned: rows.length, purged, failed, skipped };
}
