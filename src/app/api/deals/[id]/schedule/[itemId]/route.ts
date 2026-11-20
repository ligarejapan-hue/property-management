import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";
import { requireDeal } from "@/lib/deals/guard";
import { scheduleItemUpdateData, scheduleItemUpdateSchema } from "@/lib/deals/schedule-route-schemas";
import { syncDealScheduleSafe, withDealLock } from "@/lib/deals/schedule-sync";
import { SETTLE_ITEM_KEY, settleDealFromSchedule, type SettleOutcome } from "@/lib/deals/settle-from-schedule";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

/** 担当・期限の変更、完了と取り消し、対象外。手で直した期限と担当は、日付が変わっても動かさない。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const p = await ctx.params;
    const id = z.string().uuid().parse(p.id);
    const itemId = z.string().uuid().parse(p.itemId);
    const body = scheduleItemUpdateSchema.parse(await parseJsonBody(request));
    await assertActiveUser(body.assigneeId, "INVALID_STAFF");
    const res = await withDealLock(id, async (tx) => {
      const before = await tx.dealScheduleItem.findFirst({ where: { id: itemId, dealId: id }, select: { templateKey: true, completedAt: true } });
      const r = await tx.dealScheduleItem.updateMany({ where: { id: itemId, dealId: id }, data: scheduleItemUpdateData(body, new Date()) });
      return { count: r.count, before };
    });
    if (res.count === 0) throw new ApiError(404, "項目が見つかりません", "NOT_FOUND");
    await writeAuditLog({
      userId: session.id, action: "deal_schedule_update", targetTable: "deals", targetId: id,
      // itemId と completed は経緯の「誰が完了にしたか・取り消したか」に使う。
      detail: { op: "update", fields: Object.keys(body).sort(), count: 1, itemId, ...(body.completed !== undefined ? { completed: body.completed } : {}) },
    });
    // 「決済・引渡し」を完了にしたら、取引の状態を決済完了にする(2026-11-20 発注者)。
    // 状態を変えられない人のときは変えずに知らせる。失敗しても完了の保存は取り消さない(状態は基本タブで変えられる)。
    let settle: SettleOutcome | null = null;
    if (body.completed === true && res.before?.templateKey === SETTLE_ITEM_KEY && !res.before.completedAt) {
      try {
        settle = await settleDealFromSchedule(session, perms, id);
      } catch (e) {
        console.error("[deal-schedule] 取引の状態を決済完了にできませんでした", { error: e instanceof Error ? e.name : "unknown" });
      }
      if (settle?.result === "settled") {
        await writeAuditLog({
          userId: session.id, action: "deal_schedule_update", targetTable: "deals", targetId: id,
          detail: { op: "auto_settle", fields: ["status"], count: 1, itemId },
        });
        await syncDealScheduleSafe(id, { userId: session.id, event: { settled: true } });
      }
    }
    return NextResponse.json({
      ok: true,
      ...(settle ? { dealStatus: settle.result, ...(settle.result === "settled" && settle.caseStatusNotChanged ? { caseStatusNotChanged: true } : {}) } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
