import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { buildSnapshotFromProperty, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({ version: z.number().int().positive() }).strict();

/** 「物件から取り直す」: 物件の今の値で写しを上書きする(写しに手で直した分も上書きされる=画面で確認してから押す)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { version } = bodySchema.parse(await parseJsonBody(request));
    const deal = await prisma.deal.findUnique({ where: { id }, select: { propertyId: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    if (!deal.propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
    const p = await prisma.property.findUnique({ where: { id: deal.propertyId }, select: SNAPSHOT_PROPERTY_SELECT });
    if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");

    const res = await prisma.deal.updateMany({
      where: { id, version },
      data: { propertySnapshot: buildSnapshotFromProperty(p), version: { increment: 1 } },
    });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_property_refresh", targetTable: "deals", targetId: id,
      detail: { fields: ["propertySnapshot"] },
    });
    return NextResponse.json({ version: version + 1 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
