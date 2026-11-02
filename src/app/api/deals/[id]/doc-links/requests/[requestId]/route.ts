import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { withDealLock } from "@/lib/deals/schedule-sync";
import { DOC_FILES_PER_LINK, DOC_LINK_REJECT_REASON_MAX } from "@/lib/deals/doc-links/constants";
import { docLinkAccess } from "@/lib/deals/doc-links/staff-store";

type Ctx = { params: Promise<{ id: string; requestId: string }> };
const fileIds = z.array(z.string().uuid()).min(1).max(DOC_FILES_PER_LINK);
const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("receive"), fileIds }).strict(),
  z.object({ action: z.literal("reject"), fileIds, reason: z.string().trim().min(1, "差し戻しの理由を入れてください").max(DOC_LINK_REJECT_REASON_MAX) }).strict(),
]);
const UNREVIEWED = ["unreviewed", "deal_cancelled_unreviewed"];

/**
 * 受領・差し戻し。中身を見られる人だけ。確認待ちの書類だけを動かす(同時に押されても二重にならない)。
 * ⚠画面に出ていたファイルの組と今の未確認のファイルの組が違えば 409(見ていないファイルを受領にしない・@codex #631 P2)。
 * 理由は監査に入れない(事実と取引と件数だけ)。
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("write");
    if (!docLinkAccess(perms).canReview) throw new ApiError(403, "提出された書類を確認する権限がありません", "FORBIDDEN");
    const p = await ctx.params;
    const id = z.string().uuid().parse(p.id);
    const requestId = z.string().uuid().parse(p.requestId);
    const body = reviewSchema.parse(await parseJsonBody(request));
    const now = new Date();
    const received = body.action === "receive";
    const count = await withDealLock(id, async (tx) => {
      const cur = await tx.dealDocRequest.findFirst({ where: { id: requestId, link: { dealId: id } }, select: { status: true } });
      if (!cur) throw new ApiError(404, "書類が見つかりません", "NOT_FOUND");
      if (cur.status !== "submitted") throw new ApiError(409, "確認待ちの書類ではありません。画面を読み込み直してください。", "NOT_SUBMITTED");
      const current = await tx.dealDocFile.findMany({ where: { requestId, reviewState: { in: UNREVIEWED } }, select: { id: true } });
      const shown = new Set(body.fileIds);
      if (current.length !== shown.size || current.some((f) => !shown.has(f.id))) {
        throw new ApiError(409, "新しいファイルが届いています。画面を読み込み直して、中身を確かめてください。", "FILES_CHANGED");
      }
      await tx.dealDocRequest.update({
        where: { id: requestId },
        data: { status: received ? "received" : "rejected", rejectReason: received ? null : body.reason, reviewedById: session.id, reviewedAt: now },
      });
      // 再提出で上の行は書き換わるので、履歴は別に残す。
      await tx.dealDocReviewEvent.create({
        data: { requestId, action: received ? "received" : "rejected", reason: received ? null : body.reason, reviewedById: session.id, createdAt: now },
      });
      const res = await tx.dealDocFile.updateMany({
        where: { requestId, reviewState: { in: UNREVIEWED } },
        data: { reviewState: received ? "received" : "rejected", reviewStateAt: now },
      });
      return res.count;
    });
    await writeAuditLog({
      userId: session.id, action: received ? "deal_doc_receive" : "deal_doc_reject", targetTable: "deals", targetId: id, detail: { count },
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
