/**
 * 「査定のご報告」の周辺地図を作り直す(2026-11-11)。POST のみ。
 * - 物件の GPS 座標を中心に、国土地理院ベクトルタイルを取って地図を作る(サーバーが取りに行く)。
 * - 作り直したら下書きに戻る(新しい地図を確かめてから表示する)。
 * ⚠権限は資料を直すときと同じ(査定報告書を開ける人 + 物件の編集 + スコープ)。
 * ⚠応答・AuditLog に緯度経度・地図のデータは出さない。
 */
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { assertAppraisalDeckAccess } from "@/lib/appraisal-deck/access";
import { refreshDeckMap } from "@/lib/appraisal-deck/map/refresh";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; deckId: string }> }) {
  try {
    const { id, deckId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    await assertAppraisalDeckAccess(session, permissions, id, "write");
    const r = await refreshDeckMap({ deckId, propertyId: id, userId: session.id, mode: "manual" });
    if (r.ok) return apiResponse({ result: "ok", buildings: r.buildings });
    if (r.reason === "not_found") throw new ApiError(404, "資料が見つかりません", "NOT_FOUND");
    if (r.reason === "no_location") {
      throw new ApiError(422, "物件の位置を求められませんでした(GPS 座標がなく、住所からも見つかりません)。物件の基本情報で緯度・経度を登録してください", "NO_LOCATION");
    }
    throw new ApiError(502, "国土地理院の地図データを取得できませんでした。少し時間をおいてもう一度お試しください", "MAP_FETCH_FAILED");
  } catch (error) {
    return handleApiError(error);
  }
}
