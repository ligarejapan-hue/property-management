import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody, type ApiSession, type PermissionEntry } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal } from "@/lib/deals/guard";
import { addSellersFromOwners, loadSellerCandidates, sellerAccessOf } from "@/lib/deals/seller-from-owners";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
/** ownerIds なし=売主がいない取引の全員。あり=担当者が選んだ人だけ。 */
const bodySchema = z.object({ ownerIds: z.array(z.string().uuid()).min(1).max(100).optional() }).strict();

/** 取引を編集でき、物件を見られて、所有者の氏名をそのまま見られる人だけ。⚠候補の人数も見せないので GET も同じ判定。 */
async function targetOf(session: ApiSession, perms: PermissionEntry[], rawId: string) {
  const dealId = z.string().uuid().parse(rawId);
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { propertyId: true } });
  if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
  if (!deal.propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
  if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
  const p = await prisma.property.findUnique({ where: { id: deal.propertyId }, select: { createdBy: true, assignedTo: true } });
  if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");
  const access = sellerAccessOf(perms);
  if (!access.name) throw new ApiError(403, "所有者の氏名を見る権限がありません", "FORBIDDEN");
  return { dealId, propertyId: deal.propertyId, access };
}

/** 売主がいる取引の、売主にいない所有者。読むだけ。 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const target = await targetOf(session, perms, (await ctx.params).id);
    return NextResponse.json(await loadSellerCandidates(target), { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 物件の今の所有者を売主に足す。足すだけで、入っている売主は書き換えない。監査には人数だけ(氏名・住所は残さない)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const target = await targetOf(session, perms, (await ctx.params).id);
    const { ownerIds } = bodySchema.parse(await parseJsonBody(request));
    const added = await prisma.$transaction((tx) => addSellersFromOwners(tx, { ...target, ownerIds }));
    await writeAuditLog({
      userId: session.id, action: "deal_party_from_owners", targetTable: "deals", targetId: target.dealId,
      detail: { added },
    });
    return NextResponse.json({ added }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
