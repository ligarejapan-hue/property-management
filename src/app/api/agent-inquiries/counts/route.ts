import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";

/** ホーム用の件数(設計 §2.3)=未対応の反響・今日明日の内見(取り消し以外)。 */
export async function GET() {
  try {
    await requireAgentInquiry("read");
    const { from, to } = todayTomorrowJst(new Date());
    const [open, upcomingViewings] = await Promise.all([
      prisma.agentInquiry.count({ where: { status: "open" } }),
      prisma.agentViewing.count({ where: { canceledAt: null, scheduledAt: { gte: from, lt: to } } }),
    ]);
    return NextResponse.json({ open, upcomingViewings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
