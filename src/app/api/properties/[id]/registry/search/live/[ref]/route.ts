import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  getLiveView,
  isValidLiveRef,
} from "@/lib/registry-fetch/live-view-store";

// ---------- GET /api/properties/[id]/registry/search/live/[ref] ----------
// 実況パネルの進行状況 (ステップの固定文言 + スクショ有無 + 完了フラグ) を返す。
// - 権限は検索 POST と同一 (registry:auto_fetch + property:read)。
// - ストアの key に userId を含むため、実行者本人以外は (権限があっても) 404。
//   実況は「自分が実行した自動操作の鏡」であり、他人の実行は見せない。
// - steps の label は固定文言のみ (所在・地番・資格情報は含まれない)。
//   スクショ本体は別 route (shot/[seq]) で配信する。
// - 実況はメモリ内 TTL の一時データのため常に no-store。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; ref: string }> },
) {
  try {
    const { id, ref } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "registry", "auto_fetch")) {
      throw new ApiError(403, "謄本所在検索の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }
    if (!isValidLiveRef(ref)) {
      throw new ApiError(404, "実況が見つかりません", "NOT_FOUND");
    }

    const view = getLiveView(session.id, id, ref);
    if (!view) {
      throw new ApiError(404, "実況が見つかりません", "NOT_FOUND");
    }

    const res = apiResponse({ data: view });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    return handleApiError(error);
  }
}
