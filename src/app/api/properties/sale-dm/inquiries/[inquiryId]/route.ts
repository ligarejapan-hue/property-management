import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { requireSaleDmWriteAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { HANDLE_STATUSES } from "@/lib/sale-dm-letter/inquiry-list";
import { isPlainOwnerLevel } from "@/lib/dm-export";

const bodySchema = z.object({
  handleStatus: z.enum(HANDLE_STATUSES),
  handleNote: z.string().trim().max(500).nullable().optional(),
});

// 申込の対応状況の変更(設計 §2.5)。書き込み権限+作成者本人のキャンペーン+field_staff の担当範囲。
// 物件配下の書き込みなので親の物件行をロックしてから更新する(R50)。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmWriteAccess();
    const { inquiryId } = await params;
    const body = bodySchema.parse(await parseJsonBody(request));

    // 対応メモ(handleNote)は電話・メールの両方を平文で読める利用者にしか一覧(GET)で
    // 返さない(freeTextHidden)。読めない利用者が書き込みだけはできてしまうと、既存の
    // メモを見ずに上書き・消去できてしまうため、handleNote を含む更新は事前に拒否する
    // (@codex L2 P1)。状態(handleStatus)だけの更新はこの制限を受けない。
    const canEditNote = isPlainOwnerLevel(ownerDisplayConfig.phone) && isPlainOwnerLevel(ownerDisplayConfig.email);
    if (body.handleNote !== undefined && !canEditNote) {
      throw new ApiError(403, "対応メモを編集する権限がありません", "FORBIDDEN");
    }

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
      // ロック取得後に再読取して再判定する(@codex P2): 先の読み取りと lockPropertyRow の
      // 間に物件の担当替え/キャンペーンの作成者変更が挟まると、権限を失った field_staff が
      // それでも更新できてしまう窓が残るため。
      const locked = await tx.dmInquiry.findUnique({
        where: { id: inquiryId },
        select: {
          draft: { select: { propertyId: true, campaign: { select: { createdBy: true } }, property: { select: { createdBy: true, assignedTo: true } } } },
        },
      });
      if (
        !locked ||
        locked.draft.propertyId !== found.draft.propertyId ||
        locked.draft.campaign.createdBy !== session.id ||
        filterDraftsByFieldStaffScope([{ property: locked.draft.property }], session).length === 0
      ) {
        throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
      }
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
    // 対応メモ(handleNote)は自由記述で折り返し番号やメールアドレスなどを含みうるので、
    // 一覧(GET・toInquiryListRows)と同じ基準=電話とメールの**両方**を平文で見られる
    // 利用者にだけ返す(@codex R10 P1: 電話だけでは足りない。メールアドレスが書かれていると
    // 「電話フル・メール伏せ」の利用者に見えてしまうため)。canEditNote と同じ基準(@codex L2 P1)。
    // 状態(handleStatus)だけの更新は伏せ対象の利用者にも許す(handleNote を含む更新は上で 403)。
    return NextResponse.json(
      { inquiry: { ...updated, handleNote: canEditNote ? updated.handleNote : null, freeTextHidden: !canEditNote } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
