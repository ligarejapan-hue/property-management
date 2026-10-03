import { randomUUID } from "crypto";
import prisma from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";
import {
  applyManualReaction,
  isRefusalProtected,
  jstCalendarDay,
} from "@/lib/dm-reaction/core";
import { decideBatchUnsubscribeTarget } from "@/lib/dm-batch/qr-unsubscribe-target";

/**
 * 宛名CSVの1通の配信停止(設計 2026-10-03 §5.1)。公開の /u/ から署名検証の後に呼ぶ。
 * ロック順は確定(confirm/route.ts)と同じ並び「所有者 → 物件親行 → 控え(バッチ)行 → 控えの行」。
 * 所有者は拒否(terminal)を書くので FOR UPDATE(売却DMの停止と同じ)。
 */

export const BATCH_UNSUBSCRIBE_NOTE = "QRコードからの配信停止申込";

export type BatchUnsubscribeResult =
  | { kind: "recorded"; batchId: string; createdLog: boolean }
  | { kind: "already"; batchId: string }
  | { kind: "unsent"; batchId: string | null }
  | { kind: "missing" }
  | { kind: "conflict"; batchId: string };

export { decideBatchUnsubscribeTarget };

const ITEM_SELECT = {
  id: true,
  batchId: true,
  propertyId: true,
  ownerId: true,
  logId: true,
  itemOwners: { select: { ownerId: true } },
  batch: { select: { downloadedAt: true, confirmedAt: true, createdBy: true } },
} as const;

const LOG_SELECT = {
  id: true,
  ownerId: true,
  reactionStatus: true,
  reactedAt: true,
  reactionNote: true,
  reactionSource: true,
  manualReactionShadow: true,
  logOwners: { select: { ownerId: true } },
} as const;

type ItemRow = {
  id: string;
  batchId: string;
  propertyId: string | null;
  ownerId: string | null;
  logId: string | null;
  itemOwners: { ownerId: string }[];
  batch: { downloadedAt: Date | null; confirmedAt: Date | null; createdBy: string };
};

function ownersOf(it: { ownerId: string | null; itemOwners: { ownerId: string }[] }): string[] {
  return [...(it.ownerId ? [it.ownerId] : []), ...it.itemOwners.map((o) => o.ownerId)];
}

export async function recordBatchItemUnsubscribe(
  itemId: string,
  now: Date = new Date(),
): Promise<BatchUnsubscribeResult> {
  return prisma.$transaction(async (tx) => {
    // 先読み(無ロック): ロック対象の所有者集合を知る。
    const pre = (await tx.dmExportBatchItem.findUnique({
      where: { id: itemId },
      select: ITEM_SELECT,
    })) as ItemRow | null;
    if (!pre) return { kind: "missing" } as const;
    // 未ダウンロード=手紙はまだ存在しない。成功と言わない。
    if (!pre.batch.downloadedAt) return { kind: "unsent", batchId: pre.batchId } as const;

    const locked = ownersOf(pre);
    await lockOwnersForUpdate(tx as unknown as RawTx, locked);
    if (pre.propertyId) await lockPropertyRow(tx, pre.propertyId);
    await tx.$queryRaw`SELECT id FROM dm_export_batches WHERE id = ${pre.batchId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM dm_export_batch_items WHERE id = ${itemId}::uuid FOR UPDATE`;

    // ロック下で読み直し。所有者が増えていたら(名寄せの付け替え)中止。
    const it = (await tx.dmExportBatchItem.findUnique({
      where: { id: itemId },
      select: ITEM_SELECT,
    })) as ItemRow | null;
    if (!it) return { kind: "missing" } as const;
    const lockedSet = new Set(locked);
    if (ownersOf(it).some((id) => !lockedSet.has(id))) {
      return { kind: "conflict", batchId: it.batchId } as const;
    }

    let rows = it.logId
      ? await tx.propertyDmLog.findMany({ where: { id: it.logId }, select: LOG_SELECT })
      : [];
    const decision = decideBatchUnsubscribeTarget({
      logId: it.logId,
      logExists: rows.length > 0,
      confirmed: it.batch.confirmedAt != null,
    });

    let createdLog = false;
    if (decision === "create") {
      const logId = randomUUID();
      await tx.propertyDmLog.create({
        data: {
          id: logId,
          propertyId: it.propertyId,
          ownerId: it.ownerId,
          dmType: "owner_address",
          batchId: it.batchId,
          draftId: null,
          // @db.Date は UTC 00:00 = JST 暦日(確定・反響と同じ規約)。確定時に投函日へ直る(§5.2)。
          sentAt: new Date(`${jstCalendarDay(now)}T00:00:00Z`),
          method: "mail",
          // 公開経路にセッションは無い=控えの作成者。
          sentBy: it.batch.createdBy,
        },
      });
      const linkTargets =
        it.itemOwners.length > 0
          ? it.itemOwners.map((o) => o.ownerId)
          : it.ownerId
            ? [it.ownerId]
            : [];
      if (linkTargets.length > 0) {
        await tx.propertyDmLogOwner.createMany({
          data: linkTargets.map((ownerId) => ({ logId, ownerId })),
          skipDuplicates: true,
        });
      }
      await tx.dmExportBatchItem.update({ where: { id: itemId }, data: { logId } });
      rows = await tx.propertyDmLog.findMany({ where: { id: logId }, select: LOG_SELECT });
      createdLog = true;
    } else if (decision === "legacy_lookup") {
      // 本機能より前に確定した控え(本番には存在しない)。1件に引けるときだけ使う。
      const found = await tx.propertyDmLog.findMany({
        where: { batchId: it.batchId, propertyId: it.propertyId, ownerId: it.ownerId },
        select: LOG_SELECT,
      });
      if (found.length !== 1) return { kind: "unsent", batchId: it.batchId } as const;
      await tx.dmExportBatchItem.update({ where: { id: itemId }, data: { logId: found[0].id } });
      rows = found;
    }

    // 記録側の所有者も、ロックした集合の内側であること(連関は控えの行から写したもの)。
    for (const r of rows) {
      const ids = [...(r.ownerId ? [r.ownerId] : []), ...r.logOwners.map((o) => o.ownerId)];
      if (ids.some((id) => !lockedSet.has(id))) {
        return { kind: "conflict", batchId: it.batchId } as const;
      }
    }

    const reactedAt = new Date(`${jstCalendarDay(now)}T00:00:00Z`);
    let changed = false;
    for (const row of rows) {
      // 冪等: 守られた拒否はそのまま(同じQRの二度押しで壊れない)。
      if (isRefusalProtected(row)) continue;
      const note = row.reactionNote?.includes(BATCH_UNSUBSCRIBE_NOTE)
        ? row.reactionNote
        : row.reactionNote
          ? `${row.reactionNote}／${BATCH_UNSUBSCRIBE_NOTE}`
          : BATCH_UNSUBSCRIBE_NOTE;
      // 手動記録と同一の適用規則(優先規則に新しい経路を作らない)。
      const next = applyManualReaction(row, { status: "refused", reactedAt, note });
      await tx.propertyDmLog.update({
        where: { id: row.id },
        data: {
          reactionStatus: next.reactionStatus,
          reactedAt: next.reactedAt,
          reactionNote: next.reactionNote,
          reactionSource: next.reactionSource,
          manualReactionShadow:
            next.manualReactionShadow == null
              ? Prisma.DbNull
              : (next.manualReactionShadow as Prisma.InputJsonValue),
        },
      });
      changed = true;
    }
    return changed
      ? ({ kind: "recorded", batchId: it.batchId, createdLog } as const)
      : ({ kind: "already", batchId: it.batchId } as const);
  });
}
