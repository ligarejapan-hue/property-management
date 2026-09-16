import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";

// 社内の申込一覧(設計 §2.5・§2.7)。作成者本人のキャンペーンのみ・field_staff は担当範囲のみ。
// 連絡先(電話・メール・要望など)は所有者の電話を平文で見られる利用者にだけ返す。
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmAccess();
    const { id } = await params;
    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true, createdBy: true } });
    if (!campaign || campaign.createdBy !== session.id) {
      return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const rows = await prisma.dmInquiry.findMany({
      where: { draft: { campaignId: id } },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true, draftId: true, submittedAt: true, name: true, phone: true, email: true,
        contactPref: true, contactTime: true, message: true, handleStatus: true, handledAt: true, handleNote: true,
        draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    // Ruling P2: 「...rest」での未使用変数化(draft/property を捨てて destructure)は eslint の
    // unused-vars に引っかかるため、返す項目を明示的に列挙して組み立てる(出力は同じ)。
    const visible = filterDraftsByFieldStaffScope(
      rows.map((r) => ({ ...r, property: r.draft.property })),
      session,
    ).map((r) => ({
      id: r.id,
      draftId: r.draftId,
      submittedAt: r.submittedAt,
      name: r.name,
      phone: r.phone,
      email: r.email,
      contactPref: r.contactPref,
      contactTime: r.contactTime,
      message: r.message,
      handleStatus: r.handleStatus,
      handledAt: r.handledAt,
      handleNote: r.handleNote,
    }));
    const inquiries = toInquiryListRows(visible, isPlainOwnerLevel(ownerDisplayConfig.phone));
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_inquiry_view",
      targetTable: "dm_campaigns",
      targetId: id,
      detail: { count: inquiries.length, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json({ inquiries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
