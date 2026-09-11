import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { loadSaleDmPublicPageConfig } from "@/lib/sale-dm-letter/config-store";
import { buildLpRenderInput } from "@/lib/sale-dm-letter/lp-render-input";
import { renderLpPage, LP_PAGE_HEADERS } from "@/lib/sale-dm-letter/lp-page";

const DEVICE_VALUES = ["sp", "pc"] as const;
type Device = (typeof DEVICE_VALUES)[number];
const querySchema = z.object({ device: z.enum(DEVICE_VALUES).default("sp") });

// 見本住所(所在検索・氏名は使わない)。coarsePropertyLocation が「東京都○○区○○町」に落とす
// (番地1-2-3は切り落とされる=本物の住所・建物が特定できる粒度は決して出ない)。
const SAMPLE_ADDRESS = "東京都○○区○○町1-2-3";

// iframe に埋め込む前提で frame-ancestors 'none' → 'self' に上書きした応答ヘッダ。
// X-Frame-Options も同じ理由で SAMEORIGIN(社内の同一オリジンからの iframe だけ許す)。
const PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  ...LP_PAGE_HEADERS,
  "Content-Security-Policy": LP_PAGE_HEADERS["Content-Security-Policy"].replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
  "X-Frame-Options": "SAMEORIGIN",
};

function parseDevice(request: NextRequest): Device {
  const raw = new URL(request.url).searchParams.get("device");
  const parsed = querySchema.safeParse({ device: raw ?? undefined });
  if (!parsed.success) throw new ApiError(400, "device は sp か pc のいずれかです", "INVALID_DEVICE");
  return parsed.data.device;
}

/**
 * 社内プレビュー(設計 §2.4 PR3)。認証必須(社内のみ)・所有者の実データは使わず見本を差し込む。
 * device は表示(HTML)には影響しない(監査上の区別のみ。CSS は同じ HTML の中で幅に応じて切り替わる)。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const device = parseDevice(request);

    const v = await prisma.dmLpVariant.findFirst({
      where: { id: lpId, campaignId: id },
      select: {
        headline: true,
        lead: true,
        bodyText: true,
        faqJson: true,
        media: {
          select: { slot: true, heading: true, figureKind: true, asset: { select: { publicId: true, width: true, height: true, deletedAt: true } } },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    if (!v.headline || !v.bodyText || v.bodyText.trim().length === 0) {
      throw new ApiError(409, "先に文章を保存してください", "TEMPLATE_MISSING");
    }

    // 宛先で最も多い物件種別(image-prompt route と同じ集計)。無ければ "house"。
    const kinds = await prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { property: { select: { propertyType: true } } }, take: 500 });
    const tally = new Map<string, number>();
    for (const k of kinds) { const t = k.property?.propertyType; if (t) tally.set(t, (tally.get(t) ?? 0) + 1); }
    const propertyType = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "house";

    const cfg = await loadSaleDmPublicPageConfig();
    const html = renderLpPage(buildLpRenderInput(
      {
        variant: { headline: v.headline, lead: v.lead, bodyText: v.bodyText, faqJson: v.faqJson },
        media: v.media,
        property: { address: SAMPLE_ADDRESS, propertyType },
        company: { senderName: cfg.senderName, senderContact: cfg.senderContact },
      },
      { mode: "preview", unsubscribeUrl: null, phoneTapToken: null },
    ));

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_preview_view",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, device, viewedAt: new Date().toISOString() },
    });

    return new NextResponse(html, { status: 200, headers: PREVIEW_HEADERS });
  } catch (error) {
    return handleApiError(error);
  }
}
