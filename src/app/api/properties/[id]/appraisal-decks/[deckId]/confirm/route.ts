/**
 * 「査定のご報告」を確認済みにする(2026-11-10)。確認済みになると資料を表示・ダウンロードできる(3つ目のPR)。
 * ⚠読み取りで欠けた数字(成約想定価格・売出し価格)があるままでは確認済みにしない。
 */
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, parseJsonBody, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertAppraisalDeckAccess } from "@/lib/appraisal-deck/access";
import { appraisalOverridesSchema, mergeAppraisal } from "@/lib/appraisal-deck/overrides";
import type { AppraisalExtract } from "@/lib/appraisal-deck/parse";

/** 画面で確かめた版(GET の updatedAt)。それ以降に直された・作り直された内容は確認済みにしない(@codex #692)。 */
const bodySchema = z.object({ reviewedUpdatedAt: z.string().datetime({ offset: true }) }).strict();

const CHANGED = "資料がほかで直されました。読み直して、もう一度確かめてから確認してください";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; deckId: string }> }) {
  try {
    const { id, deckId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    await assertAppraisalDeckAccess(session, permissions, id, "write");
    const body = bodySchema.safeParse(await parseJsonBody(request));
    if (!body.success) {
      throw new ApiError(422, "確かめた資料の版がありません。読み直してからもう一度お試しください", "VALIDATION_ERROR");
    }
    const reviewed = new Date(body.data.reviewedUpdatedAt);
    const deck = await prisma.appraisalDeck.findFirst({
      where: { id: deckId, propertyId: id },
      select: { id: true, status: true, extracted: true, overrides: true, updatedAt: true },
    });
    if (!deck) throw new ApiError(404, "資料が見つかりません", "NOT_FOUND");
    if (deck.updatedAt.getTime() !== reviewed.getTime()) throw new ApiError(409, CHANGED, "CONFLICT");
    if (deck.status === "confirmed") return apiResponse({ status: "confirmed" });
    const ov = appraisalOverridesSchema.safeParse(deck.overrides ?? {});
    const merged = mergeAppraisal(deck.extracted as unknown as AppraisalExtract, ov.success ? ov.data : {});
    if (merged.expected.total == null) {
      throw new ApiError(422, "成約想定価格が入っていません。入れてから確認済みにしてください", "VALIDATION_ERROR");
    }
    if ((merged.plans?.length ?? 0) === 0 && merged.range == null) {
      throw new ApiError(422, "売出し価格(3案または価格の幅)が入っていません。入れてから確認済みにしてください", "VALIDATION_ERROR");
    }
    // 画面で確かめた版のまま確認する(確かめている間に直された内容を、見ないまま確認済みにしない)。
    const updated = await prisma.appraisalDeck.updateMany({
      where: { id: deck.id, status: "draft", updatedAt: reviewed },
      data: { status: "confirmed", confirmedBy: session.id, confirmedAt: new Date(), updatedBy: session.id },
    });
    if (updated.count !== 1) {
      throw new ApiError(409, CHANGED, "CONFLICT");
    }
    await writeAuditLog({
      userId: session.id,
      action: "update",
      targetTable: "appraisal_decks",
      targetId: deck.id,
      detail: { propertyId: id, status: "confirmed" },
    });
    return apiResponse({ status: "confirmed" });
  } catch (error) {
    return handleApiError(error);
  }
}
