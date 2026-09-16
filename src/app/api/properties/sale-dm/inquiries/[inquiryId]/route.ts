import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { requireSaleDmWriteAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { HANDLE_STATUSES } from "@/lib/sale-dm-letter/inquiry-list";

const bodySchema = z.object({
  handleStatus: z.enum(HANDLE_STATUSES),
  handleNote: z.string().trim().max(500).nullable().optional(),
});

// 申込の対応状況の変更(設計 §2.5)。書き込み権限+作成者本人のキャンペーン+field_staff の担当範囲。
// 物件配下の書き込みなので親の物件行をロックしてから更新する(R50)。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { inquiryId } = await params;
    const body = bodySchema.parse(await parseJsonBody(request));

    const found = await prisma.dmInquiry.findUnique({
      where: { id: inquiryId },
      select: {
        id: true,
        draft: { select: { propertyId: true, campaign: { select: { createdBy: true } }, property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    if (
      !found ||
      found.draft.campaign.createdBy !== session.id ||
      filterDraftsByFieldStaffScope([{ property: found.draft.property }], session).length === 0
    ) {
      throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await lockPropertyRow(tx, found.draft.propertyId);
      return tx.dmInquiry.update({
        where: { id: inquiryId },
        data: {
          handleStatus: body.handleStatus,
          handledById: body.handleStatus === "open" ? null : session.id,
          handledAt: body.handleStatus === "open" ? null : now,
          ...(body.handleNote !== undefined ? { handleNote: body.handleNote && body.handleNote.length > 0 ? body.handleNote : null } : {}),
        },
        select: { id: true, handleStatus: true, handledAt: true, handleNote: true },
      });
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_inquiry_status_update",
      targetTable: "dm_inquiries",
      targetId: inquiryId,
      detail: { handleStatus: body.handleStatus, updatedAt: now.toISOString() },
    });
    return NextResponse.json({ inquiry: updated }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
