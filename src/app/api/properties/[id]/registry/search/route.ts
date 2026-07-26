import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
  parseJsonBody,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { getRegistryFetchProvider } from "@/lib/registry-fetch/auto-fetch";
import { loadRegistryFetchCredentials } from "@/lib/registry-fetch/config-store";
import { runRegistrySearch } from "@/lib/registry-fetch/search";
import {
  beginLiveView,
  reportLiveStep,
  completeLiveView,
  isValidLiveRef,
} from "@/lib/registry-fetch/live-view-store";

// ---------- POST /api/properties/[id]/registry/search ----------
// 謄本 所在検索（PR-2b-2・add-only・検索ルートのみ）。番号無し物件を所在/地番/家屋番号で
// 謄本候補検索する。本番外部接続・Playwright・課金・env 追加・取得ルート拡張・UI は無し。
// 認証 → 権限（registry:auto_fetch + property:read・新 permission は作らない／cond⑤）→
// 入力受け口（confirmed／cond①）だけを担当し、検索・AuditLog は
// runRegistrySearch（@/lib/registry-fetch/search）へ委譲する。
//
// body: { confirmed: true }  // 確認。true 以外は 400。
//
// 本番 provider 未実装の現状は provider 未設定として 501
// （REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED）で安全停止し、外部接続・DB 書込・mock 利用を
// 一切しない（route は mock provider を new しない／cond⑦ fail-closed）。
//
// 本 route は POST handler のみを export する。

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // registry:auto_fetch（謄本連携の高リスク操作）。検索専用の新 permission は作らない。
    if (!hasPermission(permissions, "registry", "auto_fetch")) {
      throw new ApiError(403, "謄本所在検索の権限がありません", "FORBIDDEN");
    }
    // 物件情報を読む既存権限も要求する（property:read）。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    // 確認フラグ。空ボディ / JSON 不正は parseJsonBody が安全に処理する。
    const body = await parseJsonBody(request);
    // body が null / 非 object（JSON 'null' 等）でも安全に false 扱いし、500 でなく 400 を返す。
    const confirmed =
      (body as { confirmed?: unknown } | null)?.confirmed === true;
    if (!confirmed) {
      throw new ApiError(
        400,
        "謄本所在検索には確認（confirmed:true）が必要です",
        "REGISTRY_SEARCH_CONFIRMATION_REQUIRED",
      );
    }

    // 本番 provider は未実装。route は mock を直接 new せず、解決した provider が
    // 無ければ 501 で安全停止する（本番 DB・外部接続に一切触れない fail-closed）。
    // 資格情報は DB(設定画面)→env で解決して provider へ注入する。readiness 未達なら
    // provider は null のまま=501(本番挙動不変・実サイトアクセスは起きない)。
    const credentials = await loadRegistryFetchCredentials();
    const provider = getRegistryFetchProvider({ credentials });
    if (!provider) {
      throw new ApiError(
        501,
        "謄本所在検索プロバイダは未設定です",
        "REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED",
      );
    }

    // 実況パネル (任意): client 発行の liveRef があれば、検索実行中のステップ
    // 進行 + スクショを実行者本人限定のメモリ内ストアへ中継する。liveRef が
    // 不正形式なら黙って無効化 (実況なしで検索は続行 = 従来挙動)。
    const liveRefRaw = (body as { liveRef?: unknown } | null)?.liveRef;
    const liveRef =
      typeof liveRefRaw === "string" && isValidLiveRef(liveRefRaw)
        ? liveRefRaw
        : null;
    if (liveRef) {
      beginLiveView(session.id, id, liveRef);
      reportLiveStep(session.id, id, liveRef, "自動検索を受け付けました", null);
    }
    const live = liveRef
      ? {
          step(label: string, shot?: Uint8Array | null) {
            reportLiveStep(session.id, id, liveRef, label, shot ?? null);
          },
        }
      : undefined;

    try {
      const result = await runRegistrySearch(
        {
          session: { id: session.id, role: session.role },
          propertyId: id,
          confirmed,
          live,
        },
        provider,
      );
      return apiResponse(result, 200);
    } finally {
      // 成否に関わらず実況を完了へ (パネルの「実行中」を残さない)。TTL 経過で
      // ストアから消える。
      if (liveRef) completeLiveView(session.id, id, liveRef);
    }
  } catch (error) {
    return handleApiError(error);
  }
}
