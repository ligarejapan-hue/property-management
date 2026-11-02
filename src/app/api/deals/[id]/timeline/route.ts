import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireDeal } from "@/lib/deals/guard";
import { timelineAccess } from "@/lib/history-timeline/access";
import { loadTimelinePage, parseTimelineQuery } from "@/lib/history-timeline/load";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 取引の経緯=この取引+その物件の分(同じ物件の別の取引は入れない・発注者決定 2026-11-02)。
 * ⚠物件を見られない人には取引の行だけを出し、隠れていることも分からないようにする。
 */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const query = parseTimelineQuery(request);
    const deal = await prisma.deal.findUnique({
      where: { id },
      select: { id: true, dealNo: true, status: true, createdAt: true, createdBy: { select: { name: true } }, propertyId: true },
    });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    const property = deal.propertyId
      ? await prisma.property.findUnique({
          where: { id: deal.propertyId },
          select: { id: true, createdBy: true, assignedTo: true, buildingId: true, caseStatus: true },
        })
      : null;
    const access = timelineAccess(session, perms, property);
    const body = await loadTimelinePage({
      scope: { propertyId: access.property ? property?.id ?? null : null, buildingId: property?.buildingId ?? null, caseStatus: property?.caseStatus ?? null, deals: [deal] },
      access, query, userId: session.id, viewedFrom: "deal",
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
