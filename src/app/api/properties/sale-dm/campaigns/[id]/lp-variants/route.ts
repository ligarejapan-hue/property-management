import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmLpVariantCreateSchema } from "@/lib/validators-sale-dm";

// LP型(設計 2026-09-08 §2.1)。DM型(variants route)と同じ骨組み。
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const lpVariants = await prisma.dmLpVariant.findMany({ where: { campaignId: id }, orderBy: { label: "asc" } });
    return NextResponse.json({ lpVariants }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id } = await params;
    const { label, options } = saleDmLpVariantCreateSchema.parse(await parseJsonBody(request));
    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true, createdBy: true } });
    if (!campaign || campaign.createdBy !== session.id) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    const lpVariant = await prisma.dmLpVariant.create({
      data: { campaignId: id, label, tone: options.tone, length: options.length, appeal: options.appeal, strength: options.strength },
    });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_create",
      targetTable: "dm_lp_variants",
      targetId: lpVariant.id,
      // label は自由記述(PII混入し得る)。detail には保存しない。
      detail: { campaignId: id, createdAt: new Date().toISOString() },
    });
    return NextResponse.json({ lpVariant }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
