import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { loadDealBranding } from "@/lib/deals/branding-store";
import { jstDateString } from "@/lib/deals/datetime";
import { fundingInputsSchema } from "@/lib/deals/funding-schema";
import { buildFundingPlan } from "@/lib/deals/documents/funding-plan";
import { loadCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({ fundingPlan: fundingInputsSchema }).strict();

/** 資金計画表のプレビュー。保存前の入力で計算し、PDF と同じ HTML を返す(保存はしない)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { fundingPlan } = bodySchema.parse(await parseJsonBody(request));
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const [rateRows, settings, company, branding] = await Promise.all([
      prisma.dealRateTable.findMany(), loadDealSettings(), loadCompanyProfile(), loadDealBranding(),
    ]);
    const out = buildFundingPlan({
      deal: toDealView(row), rateRows, kinds: settings.propertyKinds, inputs: fundingPlan, company, today: jstDateString(new Date()),
      logo: branding.logo, text: settings.texts.funding_plan,
    });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
