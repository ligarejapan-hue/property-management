import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";
import { requireDeal } from "@/lib/deals/guard";
import { scheduleItemUpdateData, scheduleItemUpdateSchema } from "@/lib/deals/schedule-route-schemas";
import { withDealLock } from "@/lib/deals/schedule-sync";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/** 担当・期限の変更、完了と取り消し、対象外。手で直した期限と担当は、日付が変わっても動かさない。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const p = await ctx.params;
    const id = z.string().uuid().parse(p.id);
    const itemId = z.string().uuid().parse(p.itemId);
    const body = scheduleItemUpdateSchema.parse(await parseJsonBody(request));
    await assertActiveUser(body.assigneeId, "INVALID_STAFF");
    const res = await withDealLock(id, (tx) => tx.dealScheduleItem.updateMany({ where: { id: itemId, dealId: id }, data: scheduleItemUpdateData(body, new Date()) }));
    if (res.count === 0) throw new ApiError(404, "項目が見つかりません", "NOT_FOUND");
    await writeAuditLog({
      userId: session.id, action: "deal_schedule_update", targetTable: "deals", targetId: id,
      detail: { op: "update", fields: Object.keys(body).sort(), count: 1 },
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
