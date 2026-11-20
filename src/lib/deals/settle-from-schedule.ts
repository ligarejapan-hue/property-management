/**
 * 段取りの「決済・引渡し」を完了にしたら、取引の状態を決済完了(settled)にする(2026-11-20 発注者
 * 「決済・引渡しが完了になったら状態を決済完了に自動変更」)。
 * - 状態を変えられる人(管理者・取引の担当者・物件の担当者=canChangeDealStatus)が完了にしたときだけ。ほかの人なら変えずに知らせる。
 * - 中止の取引・もう決済完了の取引は動かさない。
 * - 物件の案件ステータスは、取引の基本タブで状態を変えたときと同じ決まりでそろえる(物件を編集できる人のときだけ)。
 * - ロックは物件の行 → 取引の行の順(status-link.ts の約束)。段取りの項目を書いたトランザクションとは別に行う。
 */
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { hasPermission, type PermissionMap } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { canChangeDealStatus, caseStatusWouldMove, syncCaseStatusFromDeals, syncDealDocRetention } from "./status-link";

/** 段取りの「決済・引渡し」の鍵(schedule.ts の SETTLE_KEY と同じ)。 */
export const SETTLE_ITEM_KEY = "s_settle";

export type SettleOutcome =
  | { result: "settled"; caseStatusNotChanged: boolean }
  | { result: "forbidden" | "cancelled" | "already" | "not_found" | "conflict" };

type Session = { id: string; role: string };

/** 状態の判定だけ(純関数)。 */
export function settleDecision(
  session: Session,
  deal: { status: string; assigneeId: string | null },
  property: { assignedTo: string | null } | null,
): "settle" | "forbidden" | "cancelled" | "already" {
  if (deal.status === "settled") return "already";
  if (deal.status === "cancelled") return "cancelled";
  return canChangeDealStatus(session, deal, property) ? "settle" : "forbidden";
}

export async function settleDealFromSchedule(
  session: Session, perms: PermissionMap, dealId: string,
  db: { $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> } = prisma,
): Promise<SettleOutcome> {
  return db.$transaction(async (tx) => {
    const first = await tx.deal.findUnique({ where: { id: dealId }, select: { propertyId: true } });
    if (!first) return { result: "not_found" as const };
    if (first.propertyId) await lockPropertyRow(tx, first.propertyId);
    const cur = await tx.deal.findUnique({ where: { id: dealId }, select: { status: true, assigneeId: true, propertyId: true, version: true } });
    if (!cur) return { result: "not_found" as const };
    const property = cur.propertyId
      ? await tx.property.findUnique({ where: { id: cur.propertyId }, select: { createdBy: true, assignedTo: true } })
      : null;
    const decision = settleDecision(session, cur, property);
    if (decision !== "settle") return { result: decision };
    // 権限を見た版のままのときだけ書く(見た後で担当者が替わっていたら、古い権限で状態を変えない・@codex #766 P2)。
    const res = await tx.deal.updateMany({ where: { id: dealId, status: cur.status, version: cur.version }, data: { status: "settled", version: { increment: 1 } } });
    if (res.count !== 1) return { result: "conflict" as const };
    await tx.changeLog.create({
      data: { targetTable: "deals", targetId: dealId, fieldName: "status", oldValue: cur.status, newValue: "settled", source: "auto", changedBy: session.id },
    });
    await syncDealDocRetention(tx, dealId, cur.status, "settled");
    let caseStatusNotChanged = false;
    // 物件の行を押さえた後で見直した物件にそろえる(物件を付け替えた直後でも、押さえた物件だけを動かす)。
    if (cur.propertyId && cur.propertyId === first.propertyId) {
      const canMoveCase = !!property && hasPermission(perms, "property", "write") && canAccessPropertyRecord(session, property);
      if (canMoveCase) await syncCaseStatusFromDeals(tx, { propertyId: cur.propertyId, changedBy: session.id });
      else caseStatusNotChanged = await caseStatusWouldMove(tx, cur.propertyId);
    }
    return { result: "settled" as const, caseStatusNotChanged };
  });
}
