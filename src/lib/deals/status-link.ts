/**
 * 取引の状態と物件の案件ステータスの連動(発注者決定 2026-10-31)。
 *
 *   契約予定 ↔ 契約予定 / 契約済 ↔ 契約完了 / 決済済 ↔ 決済完了 / 中止 ↔ 保留
 *   見送り・終了、他社で決まった → 中止(取引を中止にしても、この2つは保留へ戻さない)
 *   契約予定より前へ戻す → 契約済・決済済の取引は契約予定へ(契約予定と中止はそのまま)
 *   除外申請中・除外 → 査定サイトの課金と結びつくので、どちらの向きにも動かさない
 *
 * 1つの物件に取引がいくつかあるときは、新しい順で中止でない最初の取引を連動させる(全部中止なら一番新しい取引)。
 * ⚠ロック順は物件の行 → 取引の行。呼び出し側は先に lockPropertyRow する(逆の順にすると、物件と取引の同時保存で固まる)。
 * ⚠物件の版は上げない(case-status-auto.ts と同じ理由)。取引の版は上げる(開いている基本タブの古い状態で上書きさせない)。
 */
import type { CaseStatus, Prisma } from "@/generated/prisma";
import { CASE_STATUS_DEPRECATED_MAP, type CaseStatusValue } from "@/lib/property-types";
import type { DealStatus } from "./constants";

const DEAL_TO_CASE: Record<DealStatus, CaseStatusValue> = {
  considering: "contract_planned",
  contracted: "contracted",
  settled: "sold",
  cancelled: "hold",
};
const CASE_TO_DEAL: Partial<Record<string, DealStatus>> = {
  contract_planned: "considering",
  contracted: "contracted",
  sold: "settled",
  hold: "cancelled",
  closed: "cancelled",
  other_brokerage: "cancelled",
};
const BEFORE_CONTRACT_PLANNED: ReadonlySet<string> = new Set([
  "new_case", "contact_attempting", "contacting_owner", "appraisal", "negotiating", "brokerage_obtained", "on_sale",
]);
const LEAD_EXCLUSION: ReadonlySet<string> = new Set(["lead_exclusion_requested", "lead_excluded"]);
const ENDED_WITHOUT_DEAL: ReadonlySet<string> = new Set(["hold", "closed", "other_brokerage"]);

const effectiveCase = (s: string): string =>
  Object.prototype.hasOwnProperty.call(CASE_STATUS_DEPRECATED_MAP, s) ? CASE_STATUS_DEPRECATED_MAP[s] : s;

/** 取引の状態に合わせた案件ステータス。動かさないときは null。 */
export function caseStatusForDealStatus(dealStatus: string, currentCase: string): CaseStatusValue | null {
  if (!Object.prototype.hasOwnProperty.call(DEAL_TO_CASE, dealStatus)) return null;
  const cur = effectiveCase(currentCase);
  if (LEAD_EXCLUSION.has(cur)) return null;
  if (dealStatus === "cancelled" && ENDED_WITHOUT_DEAL.has(cur)) return null;
  const next = DEAL_TO_CASE[dealStatus as DealStatus];
  return next === currentCase ? null : next;
}

/** 案件ステータスに合わせた取引の状態。動かさないときは null。 */
export function dealStatusForCaseStatus(caseStatus: string, currentDeal: string): DealStatus | null {
  const cs = effectiveCase(caseStatus);
  if (BEFORE_CONTRACT_PLANNED.has(cs)) {
    return currentDeal === "contracted" || currentDeal === "settled" ? "considering" : null;
  }
  const next = Object.prototype.hasOwnProperty.call(CASE_TO_DEAL, cs) ? CASE_TO_DEAL[cs] : undefined;
  return next && next !== currentDeal ? next : null;
}

/** 物件から新しく作る取引の最初の状態。 */
export function initialDealStatusForCase(caseStatus: string): DealStatus {
  if (caseStatus === "contracted") return "contracted";
  if (caseStatus === "sold") return "settled";
  return "considering";
}

/** deals は新しい順。 */
export function pickLinkedDeal<T extends { status: string }>(deals: readonly T[]): T | null {
  return deals.find((d) => d.status !== "cancelled") ?? deals[0] ?? null;
}

const loadDeals = (tx: Prisma.TransactionClient, propertyId: string) =>
  tx.deal.findMany({
    where: { propertyId },
    select: { id: true, status: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

type SyncArgs = { propertyId: string; changedBy: string };

/** 今の取引の並びで連動させると、案件ステータスがどう動くか。動かないときは null。 */
async function plannedCaseMove(tx: Prisma.TransactionClient, propertyId: string): Promise<{ from: CaseStatus; to: CaseStatusValue } | null> {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { caseStatus: true } });
  if (!property) return null;
  const linked = pickLinkedDeal(await loadDeals(tx, propertyId));
  if (!linked) return null;
  const to = caseStatusForDealStatus(linked.status, property.caseStatus);
  return to ? { from: property.caseStatus, to } : null;
}

/** 連動させたら案件ステータスが動く場面か(読むだけ)。物件の編集権限がなくて連動させないときの知らせに使う。 */
export async function caseStatusWouldMove(tx: Prisma.TransactionClient, propertyId: string): Promise<boolean> {
  return (await plannedCaseMove(tx, propertyId)) !== null;
}

/** 取引の状態を変えた・取引を作ったあとに、案件ステータスをそろえる。物件の行をロックした tx の中で呼ぶ。 */
export async function syncCaseStatusFromDeals(tx: Prisma.TransactionClient, { propertyId, changedBy }: SyncArgs): Promise<void> {
  const move = await plannedCaseMove(tx, propertyId);
  if (!move) return;
  const res = await tx.property.updateMany({
    where: { id: propertyId, caseStatus: move.from },
    data: { caseStatus: move.to as CaseStatus },
  });
  if (res.count !== 1) return;
  await tx.changeLog.create({
    data: {
      targetTable: "properties", targetId: propertyId, fieldName: "caseStatus",
      oldValue: move.from, newValue: move.to, source: "auto", changedBy,
    },
  });
}

/**
 * 案件ステータスを変えたあとに、取引の状態をそろえる。物件の行をロックした tx の中で呼ぶ。
 * 動かした取引を返す(呼び出し側は COMMIT のあとで段取りに反映する=syncDealScheduleAfterCaseStatus)。
 */
export async function syncDealFromCaseStatus(tx: Prisma.TransactionClient, { propertyId, changedBy }: SyncArgs): Promise<{ dealId: string; status: DealStatus } | null> {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { caseStatus: true } });
  if (!property) return null;
  const linked = pickLinkedDeal(await loadDeals(tx, propertyId));
  if (!linked) return null;
  const next = dealStatusForCaseStatus(property.caseStatus, linked.status);
  if (!next) return null;
  const res = await tx.deal.updateMany({
    where: { id: linked.id, status: linked.status },
    data: { status: next, version: { increment: 1 } },
  });
  if (res.count !== 1) return null;
  await tx.changeLog.create({
    data: {
      targetTable: "deals", targetId: linked.id, fieldName: "status",
      oldValue: linked.status, newValue: next, source: "auto", changedBy,
    },
  });
  return { dealId: linked.id, status: next };
}

/**
 * 取引の状態を変えられる人=管理者・その取引の担当者・その物件の担当者(発注者決定 2026-10-31)。
 * ⚠物件の案件ステータスの変更権限は変えていない(物件を編集できる人が変えると、取引も連動する)。
 * ⚠取引の状態を変えられても、物件を編集できない人のときは案件ステータスを動かさない(発注者決定 2026-11-01)。
 */
export function canChangeDealStatus(
  session: { id: string; role: string },
  deal: { assigneeId: string | null },
  property: { assignedTo: string | null } | null,
): boolean {
  return session.role === "admin" || deal.assigneeId === session.id || property?.assignedTo === session.id;
}

/**
 * 取引の担当者を変えられる人。状態を変えられる人に加え、担当者が未設定のときの作成者(自分の取引を受け持てる)。
 * ⚠誰でも担当者を変えられると、自分を担当者にして状態の制限をすり抜けられる。
 */
export function canChangeDealAssignee(
  session: { id: string; role: string },
  deal: { assigneeId: string | null; createdById: string | null },
  property: { assignedTo: string | null } | null,
): boolean {
  return canChangeDealStatus(session, deal, property) || (deal.assigneeId === null && deal.createdById === session.id);
}
