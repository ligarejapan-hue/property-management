import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { loadDealRegistryRights } from "@/lib/deals/registry-rights-load";
import { registryRightsView } from "@/lib/deals/registry-rights";
import { registryPropertyFor } from "@/lib/deals/registry-doc-info";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 取引の物件の謄本(全部事項の最新の1件)の登記の現況(設計 §4.6.1)。確認用で、取引のデータには書き込まない。
 * 物件を見られない人には何も読まない。権利者名は「所有者の閲覧」もある人だけ。謄本を読んだときは監査に件数だけを残す。
 */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const deal = await prisma.deal.findUnique({ where: { id }, select: { id: true, propertyId: true } });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const state = await loadDealRegistryRights(await registryPropertyFor(session, perms, deal.propertyId));
    const rights = registryRightsView(state, { showNames: hasPermission(perms, "owner", "read") });
    if (state.status !== "none") {
      await writeAuditLog({
        userId: session.id, action: "deal_registry_rights_view", targetTable: "deals", targetId: id,
        detail: {
          status: rights.status,
          activeRights: rights.status === "ok" ? rights.activeRights.length : 0,
          cautions: rights.status === "ok" ? rights.cautions.length : 0,
        },
      });
    }
    return NextResponse.json({ rights }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
