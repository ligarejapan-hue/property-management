import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { findDraftTarget, loadRequestDraft, type DraftFailure } from "@/lib/deals/request-drafts/store";

type Ctx = { params: Promise<{ id: string; itemId: string }> };
const NO_STORE = { "Cache-Control": "no-store" };
const shortId = z.string().min(1).max(40);
const copySchema = z.object({ templateId: shortId }).strict();

const FAILURES: Record<DraftFailure, [number, string]> = {
  item_not_found: [404, "項目が見つかりません"],
  no_template: [404, "この項目に結びついた依頼文のひな形がありません"],
  bad_template: [422, "ひな形を選び直してください"],
  bad_recipient: [422, "宛先を選び直してください"],
  deal_not_found: [404, "取引が見つかりません"],
};
const failure = (code: DraftFailure) => new ApiError(FAILURES[code][0], FAILURES[code][1], code.toUpperCase());

async function idsOf(ctx: Ctx) {
  const p = await ctx.params;
  return { dealId: z.string().uuid().parse(p.id), itemId: z.string().uuid().parse(p.itemId) };
}

/** 差し込み済みの文面を作る。保存はしない。⚠文面にはリンクや氏名が入るので、監査にも console にも出さない。 */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const { session, perms } = await requireDeal("read");
    const { dealId, itemId } = await idsOf(ctx);
    const q = new URL(request.url).searchParams;
    const templateId = q.get("templateId");
    const recipientId = q.get("recipientId");
    const draft = await loadRequestDraft({
      dealId, itemId, session, perms, now: new Date(),
      templateId: templateId === null ? null : shortId.parse(templateId),
      recipientId: recipientId === null ? null : shortId.parse(recipientId),
    });
    if ("failure" in draft) throw failure(draft.failure);
    return NextResponse.json(draft, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}

/** コピーしたことを取引の履歴に残す(誰が・いつ・どのひな形か)。文面は受け取らない。 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("read");
    const { dealId, itemId } = await idsOf(ctx);
    const { templateId } = copySchema.parse(await parseJsonBody(request));
    const target = await findDraftTarget(dealId, itemId, templateId);
    if ("failure" in target) throw failure(target.failure);
    await writeAuditLog({
      userId: session.id, action: "deal_request_draft_copy", targetTable: "deals", targetId: dealId,
      detail: { templateKey: target.template.id, itemKey: target.template.scheduleItemKey },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
