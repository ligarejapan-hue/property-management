import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { recordChangesInTx } from "@/lib/change-log";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { assertActiveUser } from "@/lib/agent-inquiry/user-check";
import { requireDeal, DEAL_VERSION_CONFLICT_MESSAGE } from "@/lib/deals/guard";
import { dealUpdateSchema } from "@/lib/deals/schemas";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { isKnownPropertyKind } from "@/lib/deals/settings";
import { DEAL_TRACKED_FIELDS, dealChangeValues, toDealUpdateData } from "@/lib/deals/change-values";
import { DEAL_DETAIL_SELECT, toDealView } from "@/lib/deals/view";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const jsonObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const idOf = async (ctx: Ctx) => z.string().uuid().parse((await ctx.params).id);

/** 取引の詳しい中身。物件を開くリンクは、その物件を見られる人にだけ出す。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = await idOf(ctx);
    const row = await prisma.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
    if (!row) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    let canOpenProperty = false;
    if (row.propertyId && hasPermission(perms, "property", "read")) {
      const p = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { createdBy: true, assignedTo: true } });
      canOpenProperty = !!p && canAccessPropertyRecord(session, p);
    }
    return NextResponse.json({ deal: toDealView(row), canOpenProperty }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 基本・物件の写し・相手方の仲介会社の変更(版の番号で 409・送っていない項目は触らない)。 */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const id = await idOf(ctx);
    const { version, ...patch } = dealUpdateSchema.parse(await parseJsonBody(request));
    for (const key of ["assigneeId", "licensedAgentId", "salesStaffId", "opsStaffId"] as const) {
      await assertActiveUser(patch[key], "INVALID_STAFF");
    }
    if (patch.propertyKind !== undefined && !isKnownPropertyKind(await loadDealSettings(), patch.propertyKind)) {
      throw new ApiError(422, "物件種別を選び直してください", "UNKNOWN_PROPERTY_KIND");
    }

    await prisma.$transaction(async (tx) => {
      const cur = await tx.deal.findUnique({ where: { id }, select: DEAL_DETAIL_SELECT });
      if (!cur) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
      const data = toDealUpdateData(patch, cur.businessType);
      // 資金計画表・事業計画書は plan_inputs のそれぞれの鍵(funding / business)だけを差し替える(ほかの鍵は残す)。
      if (patch.businessPlan !== undefined && (patch.businessType ?? cur.businessType) !== "resale") {
        throw new ApiError(422, "事業計画書は買取再販の取引だけで使えます", "NOT_RESALE");
      }
      if (patch.fundingPlan !== undefined || patch.businessPlan !== undefined) {
        data.planInputs = {
          ...jsonObject(cur.planInputs),
          ...(patch.fundingPlan !== undefined ? { funding: patch.fundingPlan } : {}),
          ...(patch.businessPlan !== undefined ? { business: patch.businessPlan } : {}),
        };
      }
      const res = await tx.deal.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
      if (res.count === 0) throw new ApiError(409, DEAL_VERSION_CONFLICT_MESSAGE, "VERSION_CONFLICT");
      await recordChangesInTx(tx, {
        targetTable: "deals", targetId: id, changedBy: session.id,
        oldValues: dealChangeValues(cur), newValues: dealChangeValues({ ...cur, ...data }),
        trackedFields: DEAL_TRACKED_FIELDS, source: "manual",
      });
    });

    await writeAuditLog({
      userId: session.id, action: "deal_update", targetTable: "deals", targetId: id,
      detail: { fields: Object.keys(patch).sort() },
    });
    return NextResponse.json({ version: version + 1 }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
