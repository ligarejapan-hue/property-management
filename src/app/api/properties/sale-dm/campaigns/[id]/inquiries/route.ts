import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { isPlainOwnerLevel } from "@/lib/dm-export";
import { toInquiryListRows } from "@/lib/sale-dm-letter/inquiry-list";

const PAGE_SIZE = 100;

/** offset クエリパラメータの読み取り。不正値(NaN/負/大きすぎ)は先頭ページ扱いにする。 */
function parseOffset(req: NextRequest): number {
  const raw = new URL(req.url).searchParams.get("offset");
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return 0;
  return n;
}

// 社内の申込一覧(設計 §2.5・§2.7)。作成者本人のキャンペーンのみ・field_staff は担当範囲のみ。
// 連絡先(電話・要望など)は所有者の電話を平文で見られる利用者にだけ返す。
// メールは所有者の owner_email を平文で見られる利用者にだけ返す(電話とは別レベル・@codex P1)。
// ページングはオフセット方式・固定ページサイズ。並べ替えは DB 側で行いページをまたいでも一貫させる
// (@codex P2: 無制限一覧は件数が増えると重い・応答も大きくなる)。
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, ownerDisplayConfig } = await requireSaleDmAccess();
    const { id } = await params;
    const offset = parseOffset(req);
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
      },
      // handleStatus は "open" > "in_progress" > "done" の文字列辞書順が desc で望む順
      // (未対応が先)になる。状態値が増えたら要見直し。
      orderBy: [{ handleStatus: "desc" }, { submittedAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: PAGE_SIZE + 1,
      select: {
        id: true, draftId: true, submittedAt: true, name: true, phone: true, email: true,
        contactPref: true, contactTime: true, message: true, handleStatus: true, handledAt: true, handleNote: true,
        draft: { select: { property: { select: { createdBy: true, assignedTo: true } } } },
      },
    });
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
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
      { inquiries, hasMore, nextOffset: hasMore ? offset + PAGE_SIZE : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
