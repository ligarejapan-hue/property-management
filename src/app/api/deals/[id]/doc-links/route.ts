import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { loadDealSettings } from "@/lib/deals/settings-store";
import { kindBaseOf } from "@/lib/deals/constants";
import { syncDealScheduleSafe, withDealLock } from "@/lib/deals/schedule-sync";
import { DOC_LINK_DEFAULT_DAYS, DOC_LINK_MAX_DAYS, DOC_LINK_ROLES, docLinkExpiresAt, isDealOpenForDocs } from "@/lib/deals/doc-links/constants";
import { docLinkBaseUrl, docLinkOptions, loadDocLinksView } from "@/lib/deals/doc-links/staff-store";
import { docLinkKey, newDocLinkPublicId } from "@/lib/deals/doc-links/token";

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const issueSchema = z.object({
  partyId: z.string().uuid(),
  itemIds: z.array(z.string().min(1).max(40)).min(1, "書類を1つ以上選んでください").max(50),
  days: z.number().int().min(1).max(DOC_LINK_MAX_DAYS).default(DOC_LINK_DEFAULT_DAYS),
  /** true=リンクを作り直す(古い URL は使えなくなる)。 */
  rotate: z.boolean().default(false),
}).strict();

/** 取引の提出状況。ファイルの一覧は開ける人にだけ、URL はリンクを扱える人にだけ返す。 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { perms } = await requireDeal("read");
    const id = z.string().uuid().parse((await ctx.params).id);
    const view = await loadDocLinksView(id, perms, new Date());
    if (!view) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** 売主・買主ごとに発行する。すでにあれば書類と期限を更新する(同じ URL のまま。無効にしたリンクは作り直す)。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const id = z.string().uuid().parse((await ctx.params).id);
    const body = issueSchema.parse(await parseJsonBody(request));
    if (!docLinkKey() || !(await docLinkBaseUrl())) {
      throw new ApiError(503, "提出用リンクの設定が済んでいないため、発行できません。管理者に連絡してください。", "DOC_LINK_NOT_CONFIGURED");
    }
    const deal = await prisma.deal.findUnique({
      where: { id },
      select: { status: true, propertyKind: true, hasOc: true, parties: { where: { id: body.partyId }, select: { id: true, role: true, isSelf: true } } },
    });
    if (!deal) throw new ApiError(404, "取引が見つかりません", "NOT_FOUND");
    if (!isDealOpenForDocs(deal.status)) throw new ApiError(422, "中止・決済済の取引には発行できません", "DEAL_CLOSED");
    const party = deal.parties[0];
    if (!party || party.isSelf || !(DOC_LINK_ROLES as readonly string[]).includes(party.role)) {
      throw new ApiError(422, "売主か買主を選んでください", "INVALID_PARTY");
    }
    const settings = await loadDealSettings();
    const options = docLinkOptions(settings.checklistItems, { base: kindBaseOf(settings, deal.propertyKind), hasOc: deal.hasOc });
    const wanted = options.filter((o) => body.itemIds.includes(o.id));
    if (wanted.length !== new Set(body.itemIds).size) throw new ApiError(422, "選べない書類が入っています。画面を読み込み直してください。", "INVALID_ITEM");

    const now = new Date();
    const expiresAt = docLinkExpiresAt(now, body.days);
    await withDealLock(id, async (tx) => {
      const cur = await tx.dealDocLink.findFirst({ where: { dealId: id, partyId: party.id }, select: { id: true, revokedAt: true, partyRole: true } });
      const link = cur
        ? await tx.dealDocLink.update({
            where: { id: cur.id },
            data: { expiresAt, revokedAt: null, partyRole: party.role, ...(body.rotate || cur.revokedAt || cur.partyRole !== party.role ? { publicId: newDocLinkPublicId() } : {}) },
            select: { id: true },
          })
        : await tx.dealDocLink.create({
            data: { dealId: id, partyId: party.id, partyRole: party.role, publicId: newDocLinkPublicId(), expiresAt, createdById: session.id },
            select: { id: true },
          });
      // 外した書類は、まだ何も届いていないものだけ消す(届いたファイルは残す)。
      await tx.dealDocRequest.deleteMany({ where: { linkId: link.id, status: "pending", checklistItemId: { notIn: wanted.map((w) => w.id) } } });
      await tx.dealDocRequest.createMany({
        skipDuplicates: true,
        data: wanted.map((w, i) => ({ linkId: link.id, checklistItemId: w.id, label: w.label, sortOrder: i })),
      });
    });
    await writeAuditLog({ userId: session.id, action: "deal_doc_link_issue", targetTable: "deals", targetId: id, detail: { count: wanted.length } });
    if (party.role === "seller") await syncDealScheduleSafe(id, { userId: session.id, event: { docLinkIssued: true } });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
