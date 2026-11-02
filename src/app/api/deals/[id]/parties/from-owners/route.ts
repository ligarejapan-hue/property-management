import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { resolveCompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import { requireDeal } from "@/lib/deals/guard";
import { withDealLock } from "@/lib/deals/schedule-sync";
import { fillSellersFromOwners, sellerAccessOf } from "@/lib/deals/seller-from-owners";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 物件の所有者を売主に入れる(売主が空のときだけ)。
 * ⚠所有者の氏名をそのまま見られる人の操作だけ。見られない物件は「無い」と同じ返事にする。監査は件数だけ。
 */
export async function POST(_request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const access = sellerAccessOf(perms);
    if (!access.name) throw new ApiError(403, "所有者の氏名をそのまま見る権限がありません", "FORBIDDEN");
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
    const deal = await prisma.deal.findUnique({ where: { id }, select: { propertyId: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const { propertyId } = deal;
    if (!propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
    const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { createdBy: true, assignedTo: true } });
    if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");

    const company = resolveCompanyProfile(await prisma.companyProfile.findUnique({ where: { id: "singleton" } }));
    // 取引の行を握って数え直す(2回押しても二重に入らない)。
    const result = await withDealLock(id, (tx) => fillSellersFromOwners(tx, { dealId: id, propertyId, access, companyName: company.nameJa }));
    if (result.status === "sellers_exist") throw new ApiError(409, "売主がすでに入っています。画面を読み込み直してください。", "SELLERS_EXIST");
    if (result.status === "no_owners") throw new ApiError(422, "物件に入れられる所有者がいません", "NO_OWNERS");
    await writeAuditLog({
      userId: session.id, action: "deal_party_create", targetTable: "deals", targetId: id,
      detail: { count: result.count },
    });
    return NextResponse.json({ count: result.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
