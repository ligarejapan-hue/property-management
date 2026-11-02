import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal } from "@/lib/deals/guard";
import { addSellersFromOwners, sellerAccessOf } from "@/lib/deals/seller-from-owners";

type Ctx = { params: Promise<{ id: string }> };

/** 物件の今の所有者を売主に足す。足すだけで、入っている売主は書き換えない。監査には人数だけ(氏名・住所は残さない)。 */
export async function POST(_request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const dealId = z.string().uuid().parse((await ctx.params).id);
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { propertyId: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    if (!deal.propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
    const p = await prisma.property.findUnique({ where: { id: deal.propertyId }, select: { createdBy: true, assignedTo: true } });
    if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
    const access = sellerAccessOf(perms);
    if (!access.name) throw new ApiError(403, "所有者の氏名を見る権限がありません", "FORBIDDEN");

    const propertyId = deal.propertyId;
    const added = await prisma.$transaction((tx) => addSellersFromOwners(tx, { dealId, propertyId, access }));
    await writeAuditLog({
      userId: session.id, action: "deal_party_from_owners", targetTable: "deals", targetId: dealId,
      detail: { added },
    });
    return NextResponse.json({ added }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
