import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { partyInputSchema } from "@/lib/deals/schemas";
import { DEAL_PARTY_SELECT } from "@/lib/deals/view";

type Ctx = { params: Promise<{ id: string }> };

/** 当事者を足す。並び順は同じ役割の最後。監査には項目名だけ(氏名・住所は残さない)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const dealId = z.string().uuid().parse((await ctx.params).id);
    const body = partyInputSchema.parse(await parseJsonBody(request));
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const sortOrder = await prisma.dealParty.count({ where: { dealId, role: body.role } });
    const party = await prisma.dealParty.create({ data: { ...body, dealId, sortOrder }, select: DEAL_PARTY_SELECT });
    await writeAuditLog({
      userId: session.id, action: "deal_party_create", targetTable: "deals", targetId: dealId,
      detail: { fields: Object.keys(body).sort() },
    });
    return NextResponse.json({ party }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
