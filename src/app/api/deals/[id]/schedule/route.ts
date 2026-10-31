import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";
import { requireDeal } from "@/lib/deals/guard";
import { jstDateString } from "@/lib/deals/datetime";
import { loadScheduleItems, syncDealScheduleSafe } from "@/lib/deals/schedule-sync";
import { scheduleAddSchema } from "@/lib/deals/schedule-route-schemas";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 決済までの段取り。開いたときに今の日付・条件・謄本に合わせ直す(同期に失敗しても今の項目は出す)。
 * 担保の項目は取引を見られる人に見せるが、件数と抵当権者は返さない(発注者決定 2026-10-31)。
 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const now = new Date();
    const deal = await prisma.deal.findUnique({ where: { id }, select: { id: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    await syncDealScheduleSafe(id, { now, userId: session.id });
    const [items, fresh] = await Promise.all([
      loadScheduleItems(id),
      prisma.deal.findUnique({ where: { id }, select: { settlementAt: true } }),
    ]);
    return NextResponse.json(
      { items, today: jstDateString(now), settlementDate: fresh?.settlementAt ? jstDateString(fresh.settlementAt) : null },
      { headers: NO_STORE },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/** 項目を手で足す。担当を選ばなければ足した本人。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const body = scheduleAddSchema.parse(await parseJsonBody(request));
    await assertActiveUser(body.assigneeId, "INVALID_STAFF");
    const deal = await prisma.deal.findUnique({ where: { id }, select: { id: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const created = await prisma.dealScheduleItem.create({
      data: {
        dealId: id, label: body.label, dueDate: new Date(`${body.dueDate}T00:00:00.000Z`), dueManual: true,
        assigneeId: body.assigneeId ?? session.id, assigneeManual: true, sortOrder: 1000,
      },
      select: { id: true },
    });
    // 作業名は自由記述なので監査に残さない。
    await writeAuditLog({ userId: session.id, action: "deal_schedule_update", targetTable: "deals", targetId: id, detail: { op: "add", count: 1 } });
    return NextResponse.json(created, { status: 201, headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
