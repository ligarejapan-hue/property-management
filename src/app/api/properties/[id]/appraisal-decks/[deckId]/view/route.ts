/**
 * 「査定のご報告」の資料(1つの HTML)を表示・ダウンロードする(2026-11-10)。
 * - GET            … 表示(確認前は左上に「確認前（社内確認用）」を出す)
 * - GET ?download=1 … 確認済みだけ。HTML ファイルとして保存する(お客様に渡す)。AuditLog に記録
 * ⚠権限は一覧・詳細と同じ(査定報告書を開ける人と同じ範囲 + 物件のスコープ)。
 * ⚠AuditLog に数字・所在地は残さない。
 * - 周辺地図(2026-11-11)があれば先頭に地図のページが付く(地図のデータは形を確かめてから入れる)。
 */
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { assertAppraisalDeckAccess } from "@/lib/appraisal-deck/access";
import { appraisalOverridesSchema, mergeAppraisal } from "@/lib/appraisal-deck/overrides";
import { renderAppraisalDeck, RENDER_HEADERS } from "@/lib/appraisal-deck/render";
import type { AppraisalExtract } from "@/lib/appraisal-deck/parse";
import { parseDeckMapData } from "@/lib/appraisal-deck/map/refresh";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; deckId: string }> }) {
  try {
    const { id, deckId } = await params;
    const download = new URL(request.url).searchParams.get("download") === "1";
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    await assertAppraisalDeckAccess(session, permissions, id, "read");
    const deck = await prisma.appraisalDeck.findFirst({
      where: { id: deckId, propertyId: id },
      select: { id: true, status: true, extracted: true, overrides: true, mapData: true },
    });
    if (!deck) throw new ApiError(404, "資料が見つかりません", "NOT_FOUND");
    const confirmed = deck.status === "confirmed";
    if (download && !confirmed) {
      throw new ApiError(409, "確認済みの資料だけダウンロードできます", "CONFLICT");
    }
    const ov = appraisalOverridesSchema.safeParse(deck.overrides ?? {});
    const merged = mergeAppraisal(deck.extracted as unknown as AppraisalExtract, ov.success ? ov.data : {});
    const html = renderAppraisalDeck(merged, { draft: !confirmed, map: parseDeckMapData(deck.mapData) });
    const headers: Record<string, string> = { ...RENDER_HEADERS };
    if (download) {
      const name = `査定のご報告_${merged.appraisedOn ?? "資料"}.html`;
      headers["Content-Disposition"] = `attachment; filename="appraisal.html"; filename*=UTF-8''${encodeURIComponent(name)}`;
      await writeAuditLog({
        userId: session.id,
        action: "appraisal_deck_download",
        targetTable: "appraisal_decks",
        targetId: deck.id,
        detail: { propertyId: id },
      });
    }
    return new Response(html, { status: 200, headers });
  } catch (error) {
    return handleApiError(error);
  }
}
