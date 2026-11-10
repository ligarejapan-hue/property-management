/**
 * 物件の「査定のご報告」(2026-11-10)。
 * GET  … 一覧(状態・日時・注意の数だけ。数字は詳細で返す)
 * POST { attachmentId } … 査定報告書から下書きを作る/作り直す(確認済みは上書きしない)
 * ⚠権限は access.ts(査定報告書を開ける人と同じ範囲 + 物件のスコープ)。
 */
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, parseJsonBody, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { assertAppraisalDeckAccess } from "@/lib/appraisal-deck/access";
import { buildAppraisalDraft } from "@/lib/appraisal-deck/create-draft";

const postSchema = z.object({ attachmentId: z.string().uuid("査定報告書を選んでください") }).strict();

const FAIL_MESSAGES: Record<string, [number, string]> = {
  attachment_not_found: [404, "この物件の査定報告書が見つかりません"],
  file_not_found: [404, "査定報告書のファイルが見つかりません"],
  not_pdf: [422, "査定報告書が PDF ではありません"],
  read_failed: [422, "査定報告書の文字を読み取れませんでした。時間をおいてもう一度お試しください"],
  not_sre: [422, "対応している書式(SRE AI査定の不動産価格査定報告書)ではありません"],
  busy: [503, "査定報告書の読み取りが混み合っています。少し時間をおいてもう一度お試しください"],
  already_confirmed: [409, "確認済みの資料は作り直せません。資料を下書きに戻してから作り直してください"],
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    await assertAppraisalDeckAccess(session, permissions, id, "read");
    const rows = await prisma.appraisalDeck.findMany({
      where: { propertyId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, sourceAttachmentId: true, extracted: true, createdAt: true, updatedAt: true, confirmedAt: true },
    });
    return apiResponse({
      decks: rows.map(({ extracted, ...r }) => {
        const e = extracted as { warnings?: unknown; kind?: unknown; appraisedOn?: unknown };
        return {
          ...r,
          kind: typeof e?.kind === "string" ? e.kind : null,
          appraisedOn: typeof e?.appraisedOn === "string" ? e.appraisedOn : null,
          warningCount: Array.isArray(e?.warnings) ? e.warnings.length : 0,
        };
      }),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    const property = await assertAppraisalDeckAccess(session, permissions, id, "write");
    if (property.isArchived) {
      throw new ApiError(422, "しまってある物件では作れません。物件を戻してからお試しください", "VALIDATION_ERROR");
    }
    const parsed = postSchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      throw new ApiError(422, parsed.error.issues[0]?.message ?? "査定報告書を選んでください", "VALIDATION_ERROR");
    }
    const result = await buildAppraisalDraft({
      attachmentId: parsed.data.attachmentId,
      propertyId: id,
      userId: session.id,
      replace: true,
    });
    if (!result.ok) {
      const [status, message] = FAIL_MESSAGES[result.reason] ?? [500, "下書きを作れませんでした"];
      throw new ApiError(
        status,
        message,
        status === 409 ? "CONFLICT" : status === 404 ? "NOT_FOUND" : status === 503 ? "BUSY" : "VALIDATION_ERROR",
      );
    }
    return apiResponse({ deckId: result.deckId, created: result.created }, result.created ? 201 : 200);
  } catch (error) {
    return handleApiError(error);
  }
}
