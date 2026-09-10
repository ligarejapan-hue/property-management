import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { buildImagePrompt } from "@/lib/sale-dm-letter/lp-media";
import { saleDmLpImagePromptQuerySchema } from "@/lib/validators-sale-dm";

/**
 * 生成AI(画像)向けプロンプト(設計 §2.3)。材料は LP型の設定(訴求)・リード文・小見出し・
 * 宛先で最も多い物件種別だけ。所有者名・住所などは構造上渡らない(buildImagePrompt の引数に無い)。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const url = new URL(request.url);
    const q = saleDmLpImagePromptQuerySchema.parse({
      slot: url.searchParams.get("slot") ?? undefined,
      heading: url.searchParams.get("heading") ?? undefined,
      style: url.searchParams.get("style") ?? undefined,
    });
    const v = await prisma.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { appeal: true, lead: true, bodyText: true } });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    if (q.slot === "section") {
      if (!q.heading || !lpBodyHeadings(v.bodyText ?? "").includes(q.heading)) {
        throw new ApiError(400, "その小見出しは本文にありません", "HEADING_NOT_FOUND");
      }
    }
    // 宛先で最も多い種別(種別は文面の差し込みにも使う非PII)。relation 名は schema の DmRecipientDraft.property を確認して合わせる。
    const kinds = await prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { property: { select: { propertyType: true } } }, take: 500 });
    const tally = new Map<string, number>();
    for (const k of kinds) { const t = k.property?.propertyType; if (t) tally.set(t, (tally.get(t) ?? 0) + 1); }
    const propertyKind = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const prompt = buildImagePrompt({
      slot: q.slot === "hero" ? { kind: "hero" } : { kind: "section", heading: q.heading as string },
      leadSummary: v.lead,
      appeal: v.appeal,
      propertyKind,
      style: q.style,
    });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_image_prompt_view",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, slot: q.slot, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json({ prompt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
