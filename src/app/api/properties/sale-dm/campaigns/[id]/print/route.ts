import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import {
  renderLetterSheetHtml,
  type LetterRenderInput,
} from "@/lib/sale-dm-letter/templates";
import { resolveSender } from "@/lib/sale-dm-letter/sender";
import { resolveTrackingBaseUrl } from "@/lib/sale-dm-letter/tracking";
import { buildTrackingArtifacts } from "@/lib/sale-dm-letter/qr";
import { renderTrackingSlotHtml } from "@/lib/sale-dm-letter/tracking-slot";
import { composeAddresseeHonorific } from "@/lib/sale-dm-letter/recipients";

// 確定済み(status=confirmed)の全通をページ区切りで連結した印刷用 HTML を返す。
// PII(本文・宛名・住所)を含むため no-store。本文は AuditLog に残さない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({ where: { id } });
    // 作成者本人のキャンペーンのみ印刷可(横断アクセス=範囲外PII漏洩防止)。not-found/not-owned は 404。
    if (!campaign || campaign.createdBy !== session.id) {
      throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    }

    // 確定分のみ・作成順。variant は設定一式(designTemplate 等)を引くために include。
    const drafts = await prisma.dmRecipientDraft.findMany({
      where: { campaignId: id, status: "confirmed" },
      orderBy: { createdAt: "asc" },
      include: { variant: true },
    });

    const { senderName, senderContact } = resolveSender();
    // 追跡QR/短縮URL は宛先固有の opaque トークンから生成する。郵送物(印刷)の QR は
    // 絶対URLが必須(相対パスは scheme/host が無く郵送先で機能しない)ため、base 未設定は
    // fail-closed(503)。本番は SALE_DM_TRACKING_BASE_URL 設定必須。
    const trackingBaseUrl = resolveTrackingBaseUrl();
    if (!trackingBaseUrl) {
      throw new ApiError(503, "追跡用URL(SALE_DM_TRACKING_BASE_URL)が未設定です。郵送QRには絶対URLが必要です", "TRACKING_NOT_CONFIGURED");
    }

    const letters: LetterRenderInput[] = await Promise.all(
      drafts.map(async (d) => {
        const artifacts = await buildTrackingArtifacts(d.trackingToken, trackingBaseUrl);
        return {
          designTemplate: d.variant.designTemplate,
          body: d.body,
          addresseeName: d.recipientName,
          honorific: composeAddresseeHonorific(d.honorific, d.coOwnerCount),
          recipientZip: d.recipientZip,
          recipientAddress: d.recipientAddress,
          senderName,
          senderContact,
          trackingToken: d.trackingToken,
          trackingSlotHtml: renderTrackingSlotHtml(artifacts, { caption: "スマホで読み取り(無料査定)" }),
        };
      }),
    );

    const html = renderLetterSheetHtml(campaign.name, letters);

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
