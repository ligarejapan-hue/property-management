import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import {
  toInquiryListRows,
  isInquirySegment,
  inquirySegmentWhere,
  decodeInquiryCursor,
  encodeInquiryCursor,
  inquiryCursorWhere,
} from "@/lib/sale-dm-letter/inquiry-list";

const PAGE_SIZE = 100;

// 社内の申込一覧(設計 §2.5・§2.7)。作成者本人のキャンペーンのみ・field_staff は担当範囲のみ。
// 連絡先(電話・要望など)は所有者の電話を平文で見られる利用者にだけ返す。
// メールは所有者の owner_email を平文で見られる利用者にだけ返す(電話とは別レベル・@codex P1)。
// ページングは区分(segment=active: 未対応・対応中 / done: 対応済み)ごとのキーセット方式(@codex P2)。
// 区分内の順序は submittedAt desc, id desc の不変順なので、ページの合間に新しい申込が届いたり
// 対応状況が変わったりしても、同じ行の重複や取りこぼしが起きない(オフセット方式はずれた)。
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmAccess();
    const { id } = await params;
    const searchParams = new URL(req.url).searchParams;
    const segmentRaw = searchParams.get("segment") ?? "active";
    if (!isInquirySegment(segmentRaw)) {
      throw new ApiError(400, "segment は active か done のいずれかです", "INVALID_SEGMENT");
    }
    // 不正なカーソルは先頭ページ扱い(利用者の操作でエラーにしない)。
    const cursor = decodeInquiryCursor(searchParams.get("cursor"));
    const campaign = await prisma.dmCampaign.findUnique({ where: { id }, select: { id: true, createdBy: true } });
    if (!campaign || campaign.createdBy !== session.id) {
      return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const rows = await prisma.dmInquiry.findMany({
      where: {
        draft: {
          campaignId: id,
          // field_staff のスコープは SQL 側で絞る(in-memory の filterDraftsByFieldStaffScope
          // だけだと、担当外の行がページを埋めてしまい以降のページが空に痩せる)。
          ...(session.role === "field_staff" ? { property: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } } : {}),
        },
        ...inquirySegmentWhere(segmentRaw),
        ...(cursor ? inquiryCursorWhere(cursor) : {}),
      },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      select: {
        id: true, draftId: true, submittedAt: true, name: true, phone: true, email: true,
        contactPref: true, contactTime: true, message: true, handleStatus: true, handledAt: true, handleNote: true,
        draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    // 次のカーソルは DB が返した最後の行(担当範囲の多層防御で落とす前)で作る。
    const nextCursor = hasMore ? encodeInquiryCursor(page[page.length - 1]) : null;
    // Ruling P2: 「...rest」での未使用変数化(draft/property を捨てて destructure)は eslint の
    // unused-vars に引っかかるため、返す項目を明示的に列挙して組み立てる(出力は同じ)。
    // filterDraftsByFieldStaffScope は SQL 側の絞り込みに対する多層防御として残す。
    const visible = filterDraftsByFieldStaffScope(
      page.map((r) => ({ ...r, property: r.draft.property })),
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
    const inquiries = toInquiryListRows(visible, {
      contact: isPlainOwnerLevel(ownerDisplayConfig.phone),
      email: isPlainOwnerLevel(ownerDisplayConfig.email),
    });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_inquiry_view",
      targetTable: "dm_campaigns",
      targetId: id,
      detail: { count: inquiries.length, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json(
      { inquiries, hasMore, nextCursor },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
