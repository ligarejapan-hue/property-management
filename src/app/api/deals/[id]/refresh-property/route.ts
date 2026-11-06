import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { buildSnapshotFromProperty, settlementFeesFromProperty, SNAPSHOT_PROPERTY_SELECT } from "@/lib/deals/snapshot";
import { readTerms } from "@/lib/deals/inputs";
import { applyTargetParcels, readTargetParcels } from "@/lib/deals/target-parcels";

type Ctx = { params: Promise<{ id: string }> };
const bodySchema = z.object({ version: z.number().int().positive() }).strict();

/**
 * 「物件から取り直す」: 物件の今の値で写しと精算の管理費・修繕積立金を上書きする(手で直した分も上書きされる=画面で確認してから押す)。
 * ⚠精算の条件は読んでから書く。版の条件つきの更新なので、間に別の保存が入れば 409 になり、古い条件で戻さない。
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const { version } = bodySchema.parse(await parseJsonBody(request));
    const deal = await prisma.deal.findUnique({ where: { id }, select: { propertyId: true, settlementTerms: true, targetParcels: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    if (!deal.propertyId) throw new ApiError(422, "手入力の物件の取引です", "NO_PROPERTY");
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "物件を見る権限がありません", "FORBIDDEN");
    const p = await prisma.property.findUnique({ where: { id: deal.propertyId }, select: SNAPSHOT_PROPERTY_SELECT });
    if (!p || !canAccessPropertyRecord(session, p)) throw new ApiError(404, "物件が見つかりません", "PROPERTY_NOT_FOUND");

    const fees = settlementFeesFromProperty(p);
    const hasFees = Object.keys(fees).length > 0;
    const res = await prisma.deal.updateMany({
      where: { id, version },
      data: {
        // 所在・地番と家屋番号は、この取引の土地・建物だけ(選んでいなければ全部)。
        propertySnapshot: buildSnapshotFromProperty({ ...p, ...applyTargetParcels(p, readTargetParcels(deal.targetParcels)) }),
        ...(hasFees ? { settlementTerms: { ...readTerms(deal.settlementTerms), ...fees } } : {}),
        version: { increment: 1 },
      },
    });
    if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
    await writeAuditLog({
      userId: session.id, action: "deal_property_refresh", targetTable: "deals", targetId: id,
      detail: { fields: hasFees ? ["propertySnapshot", "settlementTerms"] : ["propertySnapshot"] },
    });
    return NextResponse.json({ version: version + 1 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
