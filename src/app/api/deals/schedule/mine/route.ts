import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { jstDateString } from "@/lib/deals/datetime";
import { addYmdDays, scheduleNoticeSlot } from "@/lib/deals/schedule";
import { scheduleDealTitle } from "@/lib/deals/schedule-sync";

const LIMIT = 50;

/** 自分が担当の段取り(今日・明日・期限超過)。朝の通知と同じ対象=導入前の項目と中止の取引は出さない。 */
export async function GET() {
  try {
    const { session } = await requireDeal("read");
    const today = jstDateString(new Date());
    const rows = await prisma.dealScheduleItem.findMany({
      where: {
        assigneeId: session.id, completedAt: null, excludedAt: null,
        dueDate: { lte: new Date(`${addYmdDays(today, 1)}T00:00:00.000Z`) },
        deal: { status: { not: "cancelled" } },
        OR: [{ preIntroduction: false }, { dueDate: { gte: new Date(`${today}T00:00:00.000Z`) } }],
      },
      orderBy: [{ dueDate: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
      take: LIMIT + 1,
      select: {
        id: true, label: true, dueDate: true, preIntroduction: true,
        deal: { select: { id: true, dealNo: true, name: true, propertySnapshot: true } },
      },
    });
    const items = rows.slice(0, LIMIT).map((r) => {
      const dueDate = r.dueDate.toISOString().slice(0, 10);
      return {
        id: r.id, label: r.label, dueDate, dealId: r.deal.id, dealNo: r.deal.dealNo, dealTitle: scheduleDealTitle(r.deal),
        slot: scheduleNoticeSlot({ dueDate, completed: false, excluded: false, preIntroduction: r.preIntroduction }, today),
      };
    });
    return NextResponse.json({ items, hasMore: rows.length > LIMIT }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
