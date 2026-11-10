import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireAgentInquiry } from "@/lib/agent-inquiry/guard";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";
import { INQUIRY_KINDS, type InquiryKind } from "@/lib/agent-inquiry/constants";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ホーム用の件数(設計 §2.3)=未対応の反響・今日明日の内見(取り消し以外)。
 * ホームの重要指標(2026-11-10)のため、未対応の反響の種類別と、内見の今日・明日の内訳も返す(件数だけ)。
 */
export async function GET() {
  try {
    await requireAgentInquiry("read");
    const { from, to } = todayTomorrowJst(new Date());
    const tomorrow = new Date(from.getTime() + DAY_MS);
    const [byKind, viewingsToday, viewingsTomorrow] = await Promise.all([
      prisma.agentInquiry.groupBy({ by: ["kind"], where: { status: "open" }, _count: { _all: true } }),
      prisma.agentViewing.count({ where: { canceledAt: null, scheduledAt: { gte: from, lt: tomorrow } } }),
      prisma.agentViewing.count({ where: { canceledAt: null, scheduledAt: { gte: tomorrow, lt: to } } }),
    ]);
    const openByKind = Object.fromEntries(INQUIRY_KINDS.map((k) => [k, 0])) as Record<InquiryKind, number>;
    for (const r of byKind) {
      if ((INQUIRY_KINDS as readonly string[]).includes(r.kind)) openByKind[r.kind as InquiryKind] = r._count._all;
    }
    // 合計は内訳の和=内訳と食い違わない。
    const open = INQUIRY_KINDS.reduce((s, k) => s + openByKind[k], 0);
    return NextResponse.json(
      { open, upcomingViewings: viewingsToday + viewingsTomorrow, openByKind, viewingsToday, viewingsTomorrow },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
