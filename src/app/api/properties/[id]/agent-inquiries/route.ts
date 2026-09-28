import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { buildPropertyTimeline, countsFromGroups } from "@/lib/agent-inquiry/timeline";

type Ctx = { params: Promise<{ id: string }> };

/** 物件画面の「反響」欄(設計 §2.3)=件数・時系列・広告の可否。物件の閲覧規則に従う。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const id = z.string().uuid().parse((await ctx.params).id);
    await assertPropertyReadable(id, session, perms);
    // 時系列は全件を読んでから並べ、並べた後に上限をかける(物件ごとの反響は月数件の規模)。
    // 件数はそれとは別に集計クエリで数える。
    const [inquiries, ads, kindGroups, viewingGroups] = await Promise.all([
      prisma.agentInquiry.findMany({
        where: { propertyId: id },
        orderBy: { receivedAt: "desc" },
        select: {
          id: true,
          kind: true,
          receivedAt: true,
          status: true,
          contactName: true,
          agent: { select: { companyName: true } },
          viewings: {
            select: {
              id: true,
              scheduledAt: true,
              viewingType: true,
              canceledAt: true,
              resultNote: true,
              attendant: { select: { name: true } },
            },
          },
        },
      }),
      prisma.propertyAdPermission.findMany({ where: { propertyId: id }, select: { medium: true, value: true } }),
      prisma.agentInquiry.groupBy({ by: ["kind"], where: { propertyId: id }, _count: { _all: true } }),
      prisma.agentViewing.groupBy({
        by: ["viewingType"],
        where: { canceledAt: null, inquiry: { propertyId: id } },
        _count: { _all: true },
      }),
    ]);
    return NextResponse.json(
      {
        counts: countsFromGroups(kindGroups, viewingGroups),
        timeline: buildPropertyTimeline(inquiries),
        adPermissions: Object.fromEntries(ads.map((a) => [a.medium, a.value])),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
