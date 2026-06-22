import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;
    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      include: { variants: true, recipients: { orderBy: { createdAt: "asc" } } },
    });
    if (!campaign) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ campaign }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
