import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { startInquiryNotify } from "@/lib/sale-dm-letter/inquiry-notify";

// 通知の再送(設計 §2.6・発注者判断 2026-09-18)。門は閲覧権限(requireSaleDmAccess)だけで足りる
// (再送は「もう一度メールを投げる」だけで、対応状況の変更のような書き込みではない)。
// キャンペーン作成者の縛りは申込については外す方針のため、ここでも campaign.createdBy は見ない
// (inquiries/[inquiryId]/route.ts の PATCH とはこの1点だけ異なる)。field_staff は物件の
// 担当範囲(作成 or 担当)のみ。通知は物件配下を書き換えないので物件ロックは取らない。
export async function POST(_request: NextRequest, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { inquiryId } = await params;

    const found = await prisma.dmInquiry.findUnique({
      where: { id: inquiryId },
      select: {
        id: true,
        notifyStatus: true,
        draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    if (!found || filterDraftsByFieldStaffScope([{ property: found.draft.property }], session).length === 0) {
      throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
    }
    if (found.notifyStatus !== "failed") {
      throw new ApiError(409, "失敗した通知のみ再送できます", "NOT_FAILED");
    }

    startInquiryNotify(found.id);
    return NextResponse.json({ data: { started: true } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
