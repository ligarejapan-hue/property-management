/**
 * DM判断の自動仕分け(2026-11-14 発注者決定)の読み書き。決め方は decide.ts。
 *
 * - 所有者が入っていない物件: 送付可なら未判断に戻し、所有者待ちの印(dm_owner_pending)を立てる(processOwnerless)
 * - 所有者待ちの印があって所有者が入った物件: 送付可/送付不可に仕分けて印を下ろす(judgeWithOwners)
 * 見回り(sweeper.ts)が1件ずつ呼ぶ。どちらも物件の行をロックしてから今の状態を読み直す。
 *
 * ⚠DM判断は物件の編集画面が送る項目なので、変えるときは版(version)を上げる。そのかわり、誰かが物件を
 *   編集中(編集の鍵がある)なら書かずに次の見回りへ回す(その人の保存を 409 にしない)。
 * ⚠謄本の名義がシステムと違って保留にしている物件(名義の確認が済んでいない)は仕分けない(名義の確認を待つ)。
 * ⚠変更履歴は「自動」(source=auto)で残す。記録上の人は物件を作った人。
 */

import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { isResourceEditLocked } from "@/lib/edit-lock/service";
import { findTerminalExclusions, type TerminalExclusionTx } from "@/lib/dm-batch/terminal-exclusion";
import { decideDmByOwners, ownerlessDmStep, type DmStatusValue, type NoSendReason } from "./decide";

export type OwnerlessOutcome = "changed" | "marked" | "unmarked" | "skipped" | "locked";
export type JudgeOutcome = "send" | "no_send" | "unmarked" | "waiting" | "locked" | "skipped";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** 謄本の名義が違って、名義の確認が済んでいない(DM を保留にしている)物件の条件。品質チェックと同じ。 */
export const REGISTRY_OWNER_MISMATCH_OPEN = {
  registryStatus: "obtained" as const,
  registryOwnerCheck: { is: { result: "mismatch" as const, decision: null, stale: false } },
};

async function logDmChange(tx: Tx, propertyId: string, from: string, to: string, changedBy: string) {
  await tx.changeLog.create({
    data: {
      targetTable: "properties",
      targetId: propertyId,
      fieldName: "dmStatus",
      oldValue: from,
      newValue: to,
      source: "auto",
      changedBy,
    },
  });
}

/** 所有者が入っていない物件を1件。 */
export async function processOwnerless(propertyId: string): Promise<OwnerlessOutcome> {
  return prisma.$transaction(async (tx) => {
    await lockPropertyRow(tx, propertyId);
    const p = await tx.property.findUnique({
      where: { id: propertyId },
      select: {
        dmStatus: true,
        dmOwnerPending: true,
        isArchived: true,
        createdBy: true,
        _count: { select: { propertyOwners: true } },
      },
    });
    if (!p || p.isArchived || p._count.propertyOwners > 0) return "skipped";
    const step = ownerlessDmStep({ dmStatus: p.dmStatus as DmStatusValue, dmOwnerPending: p.dmOwnerPending });
    if (!step) return "skipped";
    if (step.dmStatus) {
      if (await isResourceEditLocked(tx, { resourceType: "property", resourceId: propertyId })) return "locked";
      await tx.property.update({
        where: { id: propertyId },
        data: { dmStatus: step.dmStatus, dmOwnerPending: step.dmOwnerPending, version: { increment: 1 } },
      });
      await logDmChange(tx, propertyId, p.dmStatus, step.dmStatus, p.createdBy);
      return "changed";
    }
    // 印だけ(編集画面が送らない項目なので版は上げない)
    await tx.property.updateMany({ where: { id: propertyId }, data: { dmOwnerPending: step.dmOwnerPending } });
    return step.dmOwnerPending ? "marked" : "unmarked";
  });
}

/** 所有者待ちの印があって所有者が入った物件を1件。 */
export async function judgeWithOwners(
  propertyId: string,
): Promise<{ outcome: JudgeOutcome; reasons?: NoSendReason[] }> {
  return prisma.$transaction(async (tx) => {
    await lockPropertyRow(tx, propertyId);
    const p = await tx.property.findUnique({
      where: { id: propertyId },
      select: {
        dmStatus: true,
        dmOwnerPending: true,
        isArchived: true,
        createdBy: true,
        registryStatus: true,
        registryOwnerCheck: { select: { result: true, decision: true, stale: true } },
        propertyOwners: { select: { ownerId: true } },
      },
    });
    if (!p || !p.dmOwnerPending || p.isArchived) return { outcome: "skipped" as const };
    const ownerIds = p.propertyOwners.map((o) => o.ownerId);
    if (ownerIds.length === 0) return { outcome: "skipped" as const };
    if (p.dmStatus !== "hold") {
      // 人が先に決めた(送付可/送付不可)=印を下ろすだけ
      await tx.property.updateMany({ where: { id: propertyId }, data: { dmOwnerPending: false } });
      return { outcome: "unmarked" as const };
    }
    const c = p.registryOwnerCheck;
    if (p.registryStatus === "obtained" && c && c.result === "mismatch" && c.decision === null && !c.stale) {
      return { outcome: "waiting" as const };
    }
    if (await isResourceEditLocked(tx, { resourceType: "property", resourceId: propertyId })) {
      return { outcome: "locked" as const };
    }

    const sets = await findTerminalExclusions(tx as unknown as TerminalExclusionTx, ownerIds, [propertyId]);
    const others = await tx.propertyOwner.findMany({
      where: {
        ownerId: { in: ownerIds },
        propertyId: { not: propertyId },
        property: {
          OR: [
            { dmStatus: "send", isArchived: false },
            { dmStatus: "no_send" },
          ],
        },
      },
      select: { ownerId: true, property: { select: { dmStatus: true } } },
    });
    const decision = decideDmByOwners({
      agentNameOwnerIds: ownerIds.filter((id) => sets.agentOwnerIds.has(id)),
      otherSendOwnerIds: others.filter((o) => o.property.dmStatus === "send").map((o) => o.ownerId),
      otherNoSendOwnerIds: others.filter((o) => o.property.dmStatus === "no_send").map((o) => o.ownerId),
      terminalOwnerIds: ownerIds.filter((id) => sets.ownerIds.has(id)),
      terminalOnProperty: sets.propertyIds.has(propertyId),
    });

    await tx.property.update({
      where: { id: propertyId },
      data: { dmStatus: decision.dmStatus, dmOwnerPending: false, version: { increment: 1 } },
    });
    await logDmChange(tx, propertyId, "hold", decision.dmStatus, p.createdBy);
    return { outcome: decision.dmStatus, reasons: decision.reasons };
  });
}
