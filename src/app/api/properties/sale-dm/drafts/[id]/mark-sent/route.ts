import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";

// 送付確定: 確定済み(confirmed)の下書きを sent にし、既存「送付履歴」(PropertyDmLog)へ
// 1 件記録して既存画面に連携する。冪等(既に sent なら再記録しない)。
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: { id: true, propertyId: true, status: true, campaign: { select: { createdBy: true } } },
    });
    // 作成者本人のキャンペーン配下のみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");

    // 既に送付済みなら何もしない(冪等)。
    if (draft.status === "sent") {
      return NextResponse.json(
        { id, status: "sent", alreadySent: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // 未確定(draft)からの送付は不可。先に確定(confirm)が必要。
    if (draft.status !== "confirmed") {
      throw new ApiError(409, "確定済みの下書きのみ送付できます", "INVALID_STATE");
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.dmRecipientDraft.update({
        where: { id },
        data: { status: "sent", sentAt: now },
      });
      // PropertyDmLog.sentAt は @db.Date(日付のみ)。method で売却DM由来と分かるようにする。
      await tx.propertyDmLog.create({
        data: {
          propertyId: draft.propertyId,
          sentAt: now,
          method: "sale_dm",
          sentBy: session.id,
        },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_mark_sent",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: { propertyId: draft.propertyId, sentAt: now.toISOString() },
    });

    return NextResponse.json(
      { id, status: "sent" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
