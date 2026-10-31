import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { withDealLock } from "@/lib/deals/schedule-sync";

type Ctx = { params: Promise<{ id: string }> };

/** 導入前の項目をまとめて完了にする(完了済み・対象外には触らない)。 */
export async function POST(_request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const res = await withDealLock(id, (tx) => tx.dealScheduleItem.updateMany({
      where: { dealId: id, preIntroduction: true, completedAt: null, excludedAt: null },
      data: { completedAt: new Date(), autoCompleted: false, completionHint: null },
    }));
    await writeAuditLog({ userId: session.id, action: "deal_schedule_update", targetTable: "deals", targetId: id, detail: { op: "complete_pre", count: res.count } });
    return NextResponse.json({ count: res.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
