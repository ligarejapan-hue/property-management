import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { timelineAccess } from "@/lib/history-timeline/access";
import { loadTimelinePage, parseTimelineQuery, type TimelineDeal } from "@/lib/history-timeline/load";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";

type Ctx = { params: Promise<{ id: string }> };

/** 物件の経緯(紐づく取引の分も含む)。出どころごとの権限は timelineAccess。 */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "read")) throw new ApiError(403, "権限がありません", "FORBIDDEN");
    const id = z.string().uuid().parse((await ctx.params).id);
    const query = parseTimelineQuery(request);
    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, createdBy: true, assignedTo: true, buildingId: true, caseStatus: true },
    });
    if (!property) throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    if (!canAccessPropertyRecord(session, property)) throw new ApiError(403, "この物件を閲覧する権限がありません", "FORBIDDEN");

    const access = timelineAccess(session, perms, property);
    const deals: TimelineDeal[] = access.deal
      ? await prisma.deal.findMany({
          where: { propertyId: id }, orderBy: { createdAt: "desc" },
          select: { id: true, dealNo: true, status: true, createdAt: true, createdBy: { select: { name: true } } },
        })
      : [];
    const body = await loadTimelinePage({
      scope: { propertyId: id, buildingId: property.buildingId, caseStatus: property.caseStatus, deals },
      access, query, userId: session.id, viewedFrom: "property",
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
