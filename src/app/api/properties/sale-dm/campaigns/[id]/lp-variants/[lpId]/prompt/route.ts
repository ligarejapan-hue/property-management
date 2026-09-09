import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "@/lib/sale-dm-letter/external-prompt";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";

/** LP型のプロンプト表示(設計 2026-09-08 §2.2)。DM型の prompt route と同じ(読み取り・ロック無し・指紋2つを返す)。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const v = await prisma.dmLpVariant.findFirst({
      where: { id: lpId, campaignId: id },
      select: { id: true, tone: true, length: true, appeal: true, strength: true, templateFrozenAt: true, rawTemplate: true },
    });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    const settledCount = await prisma.dmRecipientDraft.count({
      where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
    });
    const prompt = buildLpExternalPrompt(v);
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_prompt_view",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json(
      {
        prompt,
        digest: promptDigest(prompt),
        frozen: isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount }),
        rawTemplate: v.rawTemplate,
        bodyDigest: bodyTemplateDigest(v.rawTemplate),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
