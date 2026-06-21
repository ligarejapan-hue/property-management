import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { escapePrismaLikePattern, extractStorageKeyFromFileUrl } from "@/lib/uploads-authorization";

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
 */
async function isStorageKeyStillReferenced(key: string): Promise<boolean> {
  const escaped = escapePrismaLikePattern(key);
  const matchesKey = (fileUrl: string | null | undefined) =>
    extractStorageKeyFromFileUrl(fileUrl) === key;

  const attachments = await prisma.attachment.findMany({
    where: { fileUrl: { contains: escaped } },
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
 * 猶予超過の一般添付を物理削除する。
 * - dryRun: 件数のみ（storage/DB 不変）。
 * - 各行は「まだ purge 対象である場合のみ」条件付き deleteMany で原子的に確保してから削除
 *   （選択〜削除間に復元/並行 purge されたら count=0 でスキップ＝復元行を消さない・P2025 を出さない）。
 * - storage 実体は、他行が同一 key を参照していない場合のみ削除（共有 object 保護）。
 *   /uploads URL は host 有無に関わらず legacy-aware に key 抽出（他参照が無ければ実体も削除）。
 *   非/uploads・不正 URL（data:/blob: 等）は key 抽出不可で storage を触らず行のみ削除。
 *   storage 失敗はログして継続（バッチを止めない）。
 */
export async function purgeExpiredAttachments(opts: {
  now: Date;
  limit: number;
  dryRun?: boolean;
}): Promise<PurgeResult> {
  const cutoff = purgeableCutoff(opts.now);
  const rows = await findPurgeableAttachments(opts.now, opts.limit);
  if (opts.dryRun) return { scanned: rows.length, purged: 0 };

  let purged = 0;
  for (const row of rows) {
    // 条件付き確保: まだ purge 適格な場合のみ削除（復元/並行 purge ガード）。
    const { count } = await prisma.attachment.deleteMany({
      where: {
        id: row.id,
        isDeleted: true,
        type: { not: "registry" },
        deletedAt: { not: null, lte: cutoff },
      },
    });
    if (count === 0) continue; // 復元済み or 並行 purge 済み → storage も触らない

    // Legacy-aware extractor (same as sibling check / authz / retro-exif): strips host so
    // legacy absolute /uploads/ URLs are reclaimed. isStorageKeyStillReferenced is what
    // prevents collateral — we never delete a key another row still references.
    const key = extractStorageKeyFromFileUrl(row.fileUrl);
    if (key && !(await isStorageKeyStillReferenced(key))) {
      try {
        await getStorage().delete(key); // 冪等（404/NoSuchKey は握りつぶし）
      } catch (err) {
        // 行は既に削除済み。storage 失敗で残りバッチを止めない（次回/運用で回収）。
        console.error(
          `[attachment-cleanup] storage delete failed for attachment=${row.id} (${err instanceof Error ? err.name : "UnknownError"})`,
        );
      }
    }
    purged++;
  }
  return { scanned: rows.length, purged };
}
