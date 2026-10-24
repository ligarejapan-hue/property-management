import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { loadDealBranding } from "@/lib/deals/branding-store";
import { jstDateString } from "@/lib/deals/datetime";
import { businessInputsSchema } from "@/lib/deals/business-schema";
import { buildBusinessPlan } from "@/lib/deals/documents/business-plan";
import { loadCompanyProfile } from "@/lib/sales-sheet/company-profile-store";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({ businessPlan: businessInputsSchema }).strict();

/** 事業計画書のプレビュー(買取再販だけ)。保存前の入力で計算し、PDF と同じ HTML を返す(保存はしない)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { businessPlan } = bodySchema.parse(await parseJsonBody(request));
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    if (row.businessType !== "resale") throw new ApiError(422, "事業計画書は買取再販の取引だけで使えます", "NOT_RESALE");
    const [rateRows, settings, company, branding] = await Promise.all([
      prisma.dealRateTable.findMany(), loadDealSettings(), loadCompanyProfile(), loadDealBranding(),
    ]);
    const out = buildBusinessPlan({
      deal: toDealView(row), rateRows, kinds: settings.propertyKinds, matrix: settings.sectionMatrix, inputs: businessPlan,
      company, today: jstDateString(new Date()), logo: branding.logo,
    });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
