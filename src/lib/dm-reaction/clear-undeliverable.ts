/**
 * 宛先不明の解除(2026-11-13 発注者決定)。
 *
 * 所有者の登記上の住所を別の住所に替えたとき、古い住所あての「宛先不明」を、送付対象から外す
 * 理由に数えないようにする(その所有者が DM に戻れる)。
 *
 * 決まり:
 * - 記録の反響(reactionStatus)は「宛先不明」のまま残し、解除の印(日時・人)を付ける。
 * - 解除するのは、その所有者**だけ**に、所有者の住所あてで送った宛先不明(isClearableUndeliverableLog)。
 *   拒否・裏に拒否が控える記録・物件の住所あて・共有でまとめて送った記録は解除しない。
 * - 操作した人が担当できない物件(現場担当の担当外)の記録は解除しない(その物件の DM 可否も触らない)。
 * - 解除したあと、その物件に残っている宛先不明が 0 なら、物件の「宛先不明」の印を外す。
 *   その印が付いていて DM 可否が「送らない」だった物件は「送付可」に戻す(発注者決定=宛先不明が
 *   理由で送らないになっていた物件だけ。印の無い物件の「送らない」は人の判断なので触らない)。
 *
 * ロックの順序: 所有者の行(FOR UPDATE)→ 物件の行(id 順)→ 記録。
 *   拒否・宛先不明を書く処理と同じ順(所有者を先に押さえる)=宛名CSV・売却DMの出口
 *   (所有者 FOR SHARE を持ったまま除外を読む)と直列になる。
 * ⚠氏名・住所はどこにも出さない(戻り値は件数と物件の id だけ)。
 */
import { Prisma } from "@/generated/prisma";
import { activeUndeliverableLogWhere, isClearableUndeliverableLog } from "@/lib/dm-reaction/core";
import { countActiveUndeliverable } from "@/lib/dm-reaction/undeliverable-flag";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { lockPropertyRow } from "@/lib/property-record-guard";

export interface ClearUndeliverableResult {
  /** 解除した記録の数 */
  cleared: number;
  /** 共有でまとめて送った記録(ほかの所有者も入っている)=解除していない数 */
  sharedSkipped: number;
  /** 物件の住所あて・裏に拒否が控える記録・担当できない物件の記録=解除していない数 */
  otherSkipped: number;
  /** 「宛先不明」の印を外した物件の数 */
  flagsCleared: number;
  /** DM 可否を「送らない」から「送付可」に戻した物件の数 */
  dmStatusRestored: number;
}

/** その所有者に関わる、解除していない宛先不明の記録を、解除できるか・できない理由で分ける(純関数)。 */
export function classifyUndeliverableLogs(
  logs: ReadonlyArray<{
    id: string;
    propertyId: string | null;
    reactionStatus: string | null;
    undeliverableClearedAt: Date | null;
    manualReactionShadow: unknown;
    dmType: string | null;
    ownerId: string | null;
    logOwnerIds: readonly string[];
    /** 操作する人がその物件を担当できるか(物件が消えた記録は true) */
    accessible: boolean;
  }>,
  ownerId: string,
): { clearable: typeof logs; sharedSkipped: number; otherSkipped: number } {
  const clearable: Array<(typeof logs)[number]> = [];
  let sharedSkipped = 0;
  let otherSkipped = 0;
  for (const log of logs) {
    if (log.reactionStatus !== "undeliverable" || log.undeliverableClearedAt !== null) continue;
    const involved = log.ownerId === ownerId || log.logOwnerIds.includes(ownerId);
    if (!involved) continue;
    if (isClearableUndeliverableLog(log, ownerId)) {
      if (log.accessible) clearable.push(log);
      else otherSkipped += 1;
      continue;
    }
    const others =
      (log.ownerId !== null && log.ownerId !== ownerId) || log.logOwnerIds.some((id) => id !== ownerId);
    if (others) sharedSkipped += 1;
    else otherSkipped += 1;
  }
  return { clearable, sharedSkipped, otherSkipped };
}

/**
 * 解除を実行する。呼ぶ側のトランザクションの中で呼ぶ。
 * @param args.ownerId 住所を替えた所有者
 * @param args.session 操作する人(現場担当は担当する物件の記録だけ)
 * @param args.now     解除の日時
 */
export async function clearOwnerUndeliverable(
  tx: Prisma.TransactionClient,
  args: { ownerId: string; session: { id: string; role: string }; now: Date },
): Promise<ClearUndeliverableResult & { propertyIds: string[] }> {
  const { ownerId, session, now } = args;
  // ① 所有者の行を先に押さえる(拒否・宛先不明の書き手と同じ順)
  await lockOwnersForUpdate(tx as unknown as RawTx, [ownerId]);

  // ② その所有者に関わる、解除していない宛先不明の記録
  const rows = await tx.propertyDmLog.findMany({
    where: {
      ...activeUndeliverableLogWhere(),
      OR: [{ ownerId }, { logOwners: { some: { ownerId } } }],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      propertyId: true,
      reactionStatus: true,
      undeliverableClearedAt: true,
      manualReactionShadow: true,
      dmType: true,
      ownerId: true,
      logOwners: { select: { ownerId: true } },
      property: { select: { createdBy: true, assignedTo: true } },
    },
  });
  const classified = classifyUndeliverableLogs(
    rows.map((r) => ({
      id: r.id,
      propertyId: r.propertyId,
      reactionStatus: r.reactionStatus,
      undeliverableClearedAt: r.undeliverableClearedAt,
      manualReactionShadow: r.manualReactionShadow,
      dmType: r.dmType,
      ownerId: r.ownerId,
      logOwnerIds: r.logOwners.map((o) => o.ownerId),
      accessible: r.property ? canAccessPropertyRecord(session, r.property) : true,
    })),
    ownerId,
  );
  const base = {
    sharedSkipped: classified.sharedSkipped,
    otherSkipped: classified.otherSkipped,
  };
  if (classified.clearable.length === 0) {
    return { cleared: 0, ...base, flagsCleared: 0, dmStatusRestored: 0, propertyIds: [] };
  }

  // ③ 物件の行を id 順に押さえる(所有者 → 物件の順)
  const propertyIds = [
    ...new Set(classified.clearable.map((l) => l.propertyId).filter((id): id is string => !!id)),
  ].sort();
  for (const propertyId of propertyIds) await lockPropertyRow(tx, propertyId);

  // ④ 印を付ける。⚠押さえている間に別の反響へ書き換えられた記録には付けない(条件つき)
  const updated = await tx.propertyDmLog.updateMany({
    where: {
      id: { in: classified.clearable.map((l) => l.id) },
      ...activeUndeliverableLogWhere(),
    },
    data: { undeliverableClearedAt: now, undeliverableClearedBy: session.id },
  });

  // ⑤ 物件ごとに、残っている宛先不明を数え直す。0 なら印を外し、DM 可否を戻す
  let flagsCleared = 0;
  let dmStatusRestored = 0;
  for (const propertyId of propertyIds) {
    if ((await countActiveUndeliverable(tx, propertyId)) > 0) continue;
    const property = await tx.property.findUnique({
      where: { id: propertyId },
      select: { dmUndeliverableAt: true, dmStatus: true },
    });
    // ⚠印の無い物件の「送らない」は人の判断=触らない
    if (!property || property.dmUndeliverableAt === null) continue;
    const restore = property.dmStatus === "no_send";
    await tx.property.update({
      where: { id: propertyId },
      data: {
        dmUndeliverableAt: null,
        // ⚠DM 可否は物件の編集画面で変えられる項目=書くときは version を必ず進める
        ...(restore ? { dmStatus: "send", version: { increment: 1 } } : {}),
      },
    });
    flagsCleared += 1;
    if (restore) {
      dmStatusRestored += 1;
      await tx.changeLog.create({
        data: {
          targetTable: "properties",
          targetId: propertyId,
          fieldName: "dmStatus",
          oldValue: "no_send",
          newValue: "send",
          source: "manual",
          changedBy: session.id,
        },
      });
    }
  }
  return { cleared: updated.count, ...base, flagsCleared, dmStatusRestored, propertyIds };
}

export interface UndeliverableSummary {
  /** 住所を替えたときに解除できる宛先不明の記録の数 */
  clearable: number;
  /** 共有でまとめて送った記録(解除しない)の数 */
  shared: number;
  /** 物件の住所あて・裏に拒否が控える記録・担当できない物件の記録(解除しない)の数 */
  other: number;
}

/**
 * 所有者ごとの「解除していない宛先不明」の内訳(画面に件数を出すため・読むだけ)。
 * 分け方は解除の処理(clearOwnerUndeliverable)と同じ classifyUndeliverableLogs を使う
 * (画面に出した件数と、実際に解除される件数を食い違わせない)。
 * 何も無い所有者は Map に入れない。
 */
export async function loadUndeliverableSummaries(
  db: Pick<Prisma.TransactionClient, "propertyDmLog">,
  ownerIds: readonly string[],
  session: { id: string; role: string },
): Promise<Map<string, UndeliverableSummary>> {
  const out = new Map<string, UndeliverableSummary>();
  const ids = [...new Set(ownerIds)].sort();
  if (ids.length === 0) return out;
  const rows = await db.propertyDmLog.findMany({
    where: {
      ...activeUndeliverableLogWhere(),
      OR: [{ ownerId: { in: ids } }, { logOwners: { some: { ownerId: { in: ids } } } }],
    },
    select: {
      id: true,
      propertyId: true,
      reactionStatus: true,
      undeliverableClearedAt: true,
      manualReactionShadow: true,
      dmType: true,
      ownerId: true,
      logOwners: { select: { ownerId: true } },
      property: { select: { createdBy: true, assignedTo: true } },
    },
  });
  const logs = rows.map((r) => ({
    id: r.id,
    propertyId: r.propertyId,
    reactionStatus: r.reactionStatus,
    undeliverableClearedAt: r.undeliverableClearedAt,
    manualReactionShadow: r.manualReactionShadow,
    dmType: r.dmType,
    ownerId: r.ownerId,
    logOwnerIds: r.logOwners.map((o) => o.ownerId),
    accessible: r.property ? canAccessPropertyRecord(session, r.property) : true,
  }));
  for (const ownerId of ids) {
    const c = classifyUndeliverableLogs(logs, ownerId);
    if (c.clearable.length + c.sharedSkipped + c.otherSkipped === 0) continue;
    out.set(ownerId, { clearable: c.clearable.length, shared: c.sharedSkipped, other: c.otherSkipped });
  }
  return out;
}
