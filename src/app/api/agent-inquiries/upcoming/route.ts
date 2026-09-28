import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";
import { DESK_PROPERTY_SELECT, toDeskProperty } from "@/lib/agent-inquiry/desk-property";

/** 今日・明日の内見(取り消し以外・時刻順)。物件は許可リストの形。 */
export async function GET() {
  try {
    await requireAgentInquiry("read");
    const { from, to } = todayTomorrowJst(new Date());
    const rows = await prisma.agentViewing.findMany({
      where: { canceledAt: null, scheduledAt: { gte: from, lt: to } },
      orderBy: { scheduledAt: "asc" },
      take: 100,
      select: {
        id: true,
        scheduledAt: true,
        viewingType: true,
        attendant: { select: { id: true, name: true } },
        inquiry: {
          select: {
            id: true,
            contactName: true,
            agent: { select: { companyName: true } },
            property: { select: DESK_PROPERTY_SELECT },
          },
        },
      },
    });
    const viewings = rows.map(({ inquiry: { property, ...inq }, ...v }) => ({
      ...v,
      inquiry: { ...inq, property: toDeskProperty(property) },
    }));
    return NextResponse.json({ viewings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
