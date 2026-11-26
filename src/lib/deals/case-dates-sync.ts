/**
 * 物件の契約日・決済予定日は、連動する取引の契約日時・決済日時の写し(2026-11-26 発注者「入れるのは取引からのみ」)。
 *
 * - 連動する取引 = 案件ステータスと同じ(lib/deals/linked-deal.ts)。
 * - 取引の日付が空なら物件の日付も空にする(取引の日付で上書き・発注者決定)。
 * - 取引の無い物件は触らない(今入っている日付は見せるだけで残す・発注者決定)。
 * - 取引を作った・取引の日付/状態を保存した・案件ステータスから取引の状態を動かしたときに呼ぶ。
 * ⚠ロック順は物件の行 → 取引の行。物件の行をロックした tx の中で呼ぶ。
 * ⚠物件の版は上げない(案件ステータスの連動と同じ=開いている物件の編集画面を古くしない)。
 */
import type { Prisma } from "@/generated/prisma";
import { dateOnlyString, parseDateOnly } from "@/lib/case-dates";
import { jstDateString } from "./datetime";
import { LINKED_DEAL_ORDER, pickLinkedDeal } from "./linked-deal";

type DealDates = { contractAt: Date | null; settlementAt: Date | null };
export type CaseDates = { contractPlannedOn: string | null; settlementPlannedOn: string | null };

/** 取引の日時(UTC で保存)→ 日本の日付("YYYY-MM-DD")。 */
export function caseDatesOfDeal(d: DealDates): CaseDates {
  return {
    contractPlannedOn: d.contractAt ? jstDateString(d.contractAt) : null,
    settlementPlannedOn: d.settlementAt ? jstDateString(d.settlementAt) : null,
  };
}

const FIELDS = ["contractPlannedOn", "settlementPlannedOn"] as const;
const toDate = (s: string | null) => (s ? parseDateOnly(s) : null);

export async function syncCaseDatesFromDeals(
  tx: Prisma.TransactionClient,
  { propertyId, changedBy }: { propertyId: string; changedBy: string },
): Promise<void> {
  const deals = await tx.deal.findMany({
    where: { propertyId },
    select: { id: true, status: true, contractAt: true, settlementAt: true },
    orderBy: LINKED_DEAL_ORDER,
  });
  const linked = pickLinkedDeal(deals);
  if (!linked) return;
  const property = await tx.property.findUnique({
    where: { id: propertyId }, select: { contractPlannedOn: true, settlementPlannedOn: true },
  });
  if (!property) return;
  const next = caseDatesOfDeal(linked);
  const changed = FIELDS.filter((f) => dateOnlyString(property[f]) !== next[f]);
  if (!changed.length) return;
  await tx.property.updateMany({
    where: { id: propertyId },
    data: { contractPlannedOn: toDate(next.contractPlannedOn), settlementPlannedOn: toDate(next.settlementPlannedOn) },
  });
  await tx.changeLog.createMany({
    data: changed.map((f) => ({
      targetTable: "properties", targetId: propertyId, fieldName: f,
      oldValue: dateOnlyString(property[f]), newValue: next[f], source: "auto" as const, changedBy,
    })),
  });
}
