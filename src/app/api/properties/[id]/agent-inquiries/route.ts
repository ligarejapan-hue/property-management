import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { assertPropertyReadable } from "@/lib/agent-inquiry/property-access";
import { buildPropertyTimeline, countInquiries } from "@/lib/agent-inquiry/timeline";

type Ctx = { params: Promise<{ id: string }> };

/** 物件画面の「反響」欄(設計 §2.3)=件数・時系列・広告の可否。物件の閲覧規則に従う。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const id = z.string().uuid().parse((await ctx.params).id);
    await assertPropertyReadable(id, session, perms);
    const [inquiries, ads] = await Promise.all([
      prisma.agentInquiry.findMany({
        where: { propertyId: id },
        orderBy: { receivedAt: "desc" },
        take: 500,
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
    ]);
    return NextResponse.json(
      {
        counts: countInquiries(inquiries),
        timeline: buildPropertyTimeline(inquiries),
        adPermissions: Object.fromEntries(ads.map((a) => [a.medium, a.value])),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
