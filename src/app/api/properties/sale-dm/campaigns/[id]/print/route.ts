import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import {
  renderLetterSheetHtml,
  type LetterRenderInput,
} from "@/lib/sale-dm-letter/templates";
import { resolveSender } from "@/lib/sale-dm-letter/sender";

// 確定済み(status=confirmed)の全通をページ区切りで連結した印刷用 HTML を返す。
// PII(本文・宛名・住所)を含むため no-store。本文は AuditLog に残さない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({ where: { id } });
    if (!campaign) {
      throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");
    }

    // 確定分のみ・作成順。variant は設定一式(designTemplate 等)を引くために include。
    const drafts = await prisma.dmRecipientDraft.findMany({
      where: { campaignId: id, status: "confirmed" },
      orderBy: { createdAt: "asc" },
      include: { variant: true },
    });

    const { senderName, senderContact } = resolveSender();

    const letters: LetterRenderInput[] = drafts.map((d) => ({
      designTemplate: d.variant.designTemplate,
      body: d.body,
      addresseeName: d.recipientName,
      honorific: d.honorific,
      recipientZip: d.recipientZip,
      recipientAddress: d.recipientAddress,
      senderName,
      senderContact,
      trackingToken: d.trackingToken,
    }));

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
