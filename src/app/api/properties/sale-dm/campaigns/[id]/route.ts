import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      include: { variants: true, recipients: { orderBy: { createdAt: "asc" } } },
    });
    // 作成者本人のキャンペーンのみ返す(他人 UUID での横断アクセス=範囲外の宛先PII漏洩を防ぐ)。
    // 見つからない/他人のものは同じ 404 にして存在を漏らさない。
    if (!campaign || campaign.createdBy !== session.id) {
      return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ campaign }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
