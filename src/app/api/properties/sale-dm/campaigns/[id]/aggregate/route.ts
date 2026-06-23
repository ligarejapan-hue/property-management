import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { aggregateByVariant } from "@/lib/sale-dm-letter/aggregate";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      select: { id: true, name: true, createdBy: true },
    });
    // 作成者本人のキャンペーンのみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!campaign || campaign.createdBy !== session.id) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    // 集計入力は反響シグナルの生値から計算する(outcome カラムに依存しない)。
    const [variants, drafts] = await Promise.all([
      prisma.dmVariant.findMany({
        where: { campaignId: id },
        select: { id: true, label: true },
      }),
      prisma.dmRecipientDraft.findMany({
        where: { campaignId: id },
        select: {
          variantId: true,
          deliveryStatus: true,
          lpFirstAccessAt: true,
          phoneInquiryAt: true,
        },
      }),
    ]);

    const aggregate = aggregateByVariant(drafts);
    const labelByVariantId = new Map(variants.map((v) => [v.id, v.label]));

    return NextResponse.json(
      {
        campaignId: campaign.id,
        campaignName: campaign.name,
        byVariant: aggregate.byVariant.map((v) => ({
          ...v,
          label: labelByVariantId.get(v.variantId) ?? v.variantId,
        })),
        total: aggregate.total,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
