import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { withDealLock } from "@/lib/deals/schedule-sync";
import { DOC_LINK_REJECT_REASON_MAX } from "@/lib/deals/doc-links/constants";
import { docLinkAccess } from "@/lib/deals/doc-links/staff-store";

type Ctx = { params: Promise<{ id: string; requestId: string }> };
const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("receive") }).strict(),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(1, "差し戻しの理由を入れてください").max(DOC_LINK_REJECT_REASON_MAX) }).strict(),
]);

/**
 * 受領・差し戻し。中身を見られる人だけ。確認待ちの書類だけを動かす(同時に押されても二重にならない)。
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
      await tx.dealDocRequest.update({
        where: { id: requestId },
        data: { status: received ? "received" : "rejected", rejectReason: received ? null : body.reason, reviewedById: session.id, reviewedAt: now },
      });
      const res = await tx.dealDocFile.updateMany({
        where: { requestId, reviewState: { in: ["unreviewed", "deal_cancelled_unreviewed"] } },
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
