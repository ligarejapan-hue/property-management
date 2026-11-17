import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { requireSaleDmWriteAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { stopFollowupManually } from "@/lib/lead-followup/manual-stop";
import { FOLLOWUP_VIEW_SELECT, toFollowupView } from "@/lib/lead-followup/view";

type Ctx = { params: Promise<{ inquiryId: string }> };

const PROPERTY_SCOPE_SELECT = {
  draft: { select: { propertyId: true, property: { select: { createdBy: true, assignedTo: true } } } },
} as const;

/**
 * 査定申込の「追客を止める」(設計 2026-11-16 §6 PR2)。止めたら終わり(再開なし)。
 * - 守りは対応状況の変更(PATCH ../route.ts)と同じ: 売却DMの書き込み権限+現地担当は担当範囲だけ+
 *   物件配下の申込は親の物件行をロックし、ロック後に読み直して判定し直す。
 * - さらに、申込のメールを平文で見られる人だけ(一覧の追客の様子もその人にだけ出す)。
 * - 応答・監査にアドレス・件名・本文は入れない。
 */
export async function POST(_req: Request, { params }: Ctx) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmWriteAccess();
    if (!isPlainOwnerLevel(ownerDisplayConfig.email)) {
      throw new ApiError(403, "申込のメールを見る権限がありません", "FORBIDDEN");
    }
    const { inquiryId } = await params;
    const found = await prisma.dmInquiry.findUnique({ where: { id: inquiryId }, select: { id: true, ...PROPERTY_SCOPE_SELECT } });
    if (!found || filterDraftsByFieldStaffScope([{ property: found.draft?.property ?? null }], session).length === 0) {
      throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
    }
    const foundPropertyId = found.draft?.propertyId ?? null;
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      if (foundPropertyId !== null) await lockPropertyRow(tx, foundPropertyId);
      const locked = await tx.dmInquiry.findUnique({ where: { id: inquiryId }, select: PROPERTY_SCOPE_SELECT });
      if (
        !locked ||
        (locked.draft?.propertyId ?? null) !== foundPropertyId ||
        filterDraftsByFieldStaffScope([{ property: locked.draft?.property ?? null }], session).length === 0
      ) {
        throw new ApiError(404, "申込が見つかりません", "NOT_FOUND");
      }
      return stopFollowupManually(tx, { kind: "inquiry", inquiryId }, session.id, now);
    });
    await writeAuditLog({
      userId: session.id,
      action: "lead_followup_manual_stop",
      targetTable: "dm_inquiries",
      targetId: inquiryId,
      detail: { target: "inquiry", result },
    });
    const row = await prisma.leadFollowup.findUnique({ where: { inquiryId }, select: FOLLOWUP_VIEW_SELECT });
    return NextResponse.json({ result, followup: toFollowupView(row) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
