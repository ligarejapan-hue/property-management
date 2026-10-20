import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { countInquiryNotifyRecipients } from "@/lib/sale-dm-letter/inquiry-notify";
import { coarsePropertyLocation, propertyTypeLabel } from "@/lib/sale-dm-letter/tags";
import {
  toInquiryListRows,
  countInquiriesByGroup,
  decodeInquiryCursor,
  encodeInquiryCursor,
  inquiryCursorWhere,
} from "@/lib/sale-dm-letter/inquiry-list";

const PAGE_SIZE = 100;

// 全キャンペーン横断の申込一覧(発注者判断 2026-09-18: 申込は売却DMを使える人全員が見て対応できる。
// キャンペーンの作成者に限らない)。field_staff は担当範囲のみ。中身は per-campaign route
// (campaigns/[id]/inquiries)からキャンペーンの読み取りと作成者判定を除いたもの+行ごとの
// 表示用項目(campaignId/campaignName/location/propertyTypeLabel)を追加。
// 連絡先(電話・要望など)は所有者の電話を平文で見られる利用者にだけ返す。
// メールは所有者の owner_email を平文で見られる利用者にだけ返す(電話とは別レベル・@codex P1)。
// ページングは状態で絞らない1本のキーセット方式(@codex P2)。並びは submittedAt desc, id desc の不変順。
export async function GET(req: NextRequest) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmAccess();
    const searchParams = new URL(req.url).searchParams;
    // 不正なカーソルは先頭ページ扱い(利用者の操作でエラーにしない)。
    const cursor = decodeInquiryCursor(searchParams.get("cursor"));
    const scopeWhere =
      session.role === "field_staff"
        ? { draft: { property: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } } }
        : {};
    const [rows, groups, notifyRecipientCount] = await Promise.all([
      prisma.dmInquiry.findMany({
        where: { ...scopeWhere, ...(cursor ? inquiryCursorWhere(cursor) : {}) },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE + 1,
        select: {
          id: true, draftId: true, submittedAt: true, name: true, phone: true, email: true,
          contactPref: true, contactTime: true, message: true, handleStatus: true, handledAt: true, handleNote: true,
          notifyStatus: true, notifyLastError: true, autoReplyStatus: true,
          // 広告用の公開ページからの申込(設計 2026-10-20): draft は null・scenario と所在地・広告の印を持つ。
          source: true, propertyAddress: true, utmSource: true, utmMedium: true, utmCampaign: true,
          scenario: { select: { id: true, name: true } },
          draft: {
            select: {
              campaign: { select: { id: true, name: true } },
              property: { select: { address: true, propertyType: true, createdBy: true, assignedTo: true } },
            },
          },
        },
      }),
      // 状態別の件数(カーソルなし=範囲全体)。個人情報は含まない。
      prisma.dmInquiry.groupBy({ by: ["handleStatus"], where: scopeWhere, _count: { _all: true } }),
      countInquiryNotifyRecipients(),
    ]);
    const counts = countInquiriesByGroup(groups);
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    // 次のカーソルは DB が返した最後の行(担当範囲の多層防御で落とす前)で作る。
    const nextCursor = hasMore ? encodeInquiryCursor(page[page.length - 1]) : null;
    // filterDraftsByFieldStaffScope は SQL 側の絞り込みに対する多層防御として残す。
    // 宛先の無い行(広告ページ)は property=null → 現地担当には出ない(field-staff-scope.ts)。
    const filtered = filterDraftsByFieldStaffScope(
      page.map((r) => ({ ...r, property: r.draft?.property ?? null })),
      session,
    );
    const sourceRows = filtered.map((r) => ({
      id: r.id,
      draftId: r.draftId,
      source: r.source,
      propertyAddress: r.propertyAddress,
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
      notifyStatus: r.notifyStatus,
      notifyLastError: r.notifyLastError,
      autoReplyStatus: r.autoReplyStatus,
    }));
    const maskedRows = toInquiryListRows(sourceRows, {
      contact: isPlainOwnerLevel(ownerDisplayConfig.phone),
      email: isPlainOwnerLevel(ownerDisplayConfig.email),
    });
    // 表示用項目(campaignId/campaignName/location/propertyTypeLabel)を付与する。物件の住所
    // そのものは返さない=coarsePropertyLocation で市区町村+町名(丁目まで)に丸めたものだけ返す。
    // 広告ページの行は campaign/location/種別が無く、代わりに DMの種類の名前と広告の経路(utm)を返す。
    // 経路は訪問者の URL 由来の自由な文字列(200字まで)=連絡先を書き込めるので、自由記述と同じ条件でだけ返す(内部レビュー 2026-10-20)。
    const freeTextVisible = isPlainOwnerLevel(ownerDisplayConfig.phone) && isPlainOwnerLevel(ownerDisplayConfig.email);
    const extraById = new Map(
      filtered.map((r) => [
        r.id,
        r.draft && r.property
          ? {
              campaignId: r.draft.campaign.id,
              campaignName: r.draft.campaign.name,
              location: coarsePropertyLocation(r.property.address),
              propertyTypeLabel: propertyTypeLabel(r.property.propertyType),
              scenarioName: null as string | null,
              adRoute: null as string | null,
            }
          : {
              campaignId: null,
              campaignName: null,
              location: null,
              propertyTypeLabel: null,
              scenarioName: r.scenario?.name ?? null,
              adRoute: freeTextVisible && [r.utmSource, r.utmMedium, r.utmCampaign].some((v) => v)
                ? [r.utmSource, r.utmMedium, r.utmCampaign].map((v) => v ?? "-").join(" / ")
                : null,
            },
      ]),
    );
    const inquiries = maskedRows.map((row) => ({
      ...row,
      ...(extraById.get(row.id) ?? { campaignId: null, campaignName: null, location: null, propertyTypeLabel: null, scenarioName: null, adRoute: null }),
    }));
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_inquiry_view",
      targetTable: "dm_inquiries",
      detail: { count: inquiries.length, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json(
      { inquiries, hasMore, nextCursor, counts, notifyRecipientCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
