import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { computeDealCalc } from "@/lib/deals/calc/deal-calc";
import { jstDateString } from "@/lib/deals/datetime";

type Ctx = { params: Promise<{ id: string }> };

/** 取引1件の計算結果(手数料・按分・印紙・決済の計算)。計算はサーバーの純粋関数だけで行う。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const [rateRows, settings] = await Promise.all([prisma.dealRateTable.findMany(), loadDealSettings()]);
    const calc = computeDealCalc(toDealView(row), rateRows, settings.propertyKinds, jstDateString(new Date()));
    return NextResponse.json({ calc }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
