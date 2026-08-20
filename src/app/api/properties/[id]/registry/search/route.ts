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
import { isPropertyScopedRole } from "@/lib/property-access";
import { getRegistryFetchProvider } from "@/lib/registry-fetch/auto-fetch";
import { loadRegistryFetchCredentials } from "@/lib/registry-fetch/config-store";
import { runRegistrySearch } from "@/lib/registry-fetch/search";
import {
  beginLiveView,
  reportLiveStep,
  attachLiveShot,
  completeLiveView,
  isValidLiveRef,
  isLiveViewCancelRequested,
  clearLiveViewCancel,
  closeLiveViewCancelWindow,
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
    // ⚠**画面の写真は『全物件を見られる役割』にだけ渡す**(@codex #394 R2 P1)。
    //   自動操作は請求リスト(口座のカート)を開き、そこには過去の操作で積み上がった
    //   **他の物件の行**が並ぶ(実測)。担当分しか見られない役割に写真を見せると、
    //   物件単位の認可を写真が素通りさせてしまう。文字の進行は誰でも見られる。
    const canSeeShots = !isPropertyScopedRole(session.role);
    if (liveRef) {
      beginLiveView(session.id, id, liveRef);
      reportLiveStep(session.id, id, liveRef, "自動検索を受け付けました", null);
      if (!canSeeShots) {
        reportLiveStep(
          session.id,
          id,
          liveRef,
          "この権限では画面の写真は記録しません(進行状況は文字でお伝えします)",
          null,
        );
      }
    }
    const live = liveRef
      ? {
          step(label: string): number {
            return reportLiveStep(session.id, id, liveRef, label, null);
          },
          attachShot(seq: number, shot: Uint8Array): void {
            if (!canSeeShots) return;
            attachLiveShot(session.id, id, liveRef, seq, shot);
          },
          // 実況パネルの「中止」。⚠provider は節目ごとにこれを見て**自分で**止まる
          // (外から処理を殺さない = 外部サイトを中途半端な状態で放り出さない)。
          // ⚠課金後は provider 側の判断で無視される (cancel-safety.ts)。
          isCancelRequested(): boolean {
            return isLiveViewCancelRequested(session.id, id, liveRef);
          },
          // ⚠自動操作が終わったら中止の受け付けを閉じる (@codex #357 P2)。
          // 以降は中止を見る場所がもう無いので、受け付けたままにすると
          // 「中止しています…」と表示したまま結果が出る食い違いが起きる。
          endCancelable(): void {
            closeLiveViewCancelWindow(session.id, id, liveRef);
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

      // ⚠番号が無い/読めないのは**入力の問題**なので 422 で止める（設計 §4.4）。
      //   200 で返すと画面は「対象外です」と出すだけで、利用者は何を直せばよいか
      //   分からない。⚠一括は同じ理由コードを「除外」「skip」に読み替えるので、
      //   止め方はこの呼び出し側でだけ決める（共通の入口は理由を返すだけ）。
      const reason = (result as { searchable?: boolean; reason?: string })
        .searchable === false
        ? (result as { reason?: string }).reason
        : undefined;
      if (reason === "missing_identifier" || reason === "malformed_identifier") {
        throw new ApiError(
          422,
          reason === "missing_identifier"
            ? "地番（建物は家屋番号）を入力してから実行してください"
            : "地番の書き方が読み取れません。地図に表示されたとおりに入力してください",
          "REGISTRY_SEARCH_IDENTIFIER_INVALID",
        );
      }

      return apiResponse(result, 200);
    } finally {
      // 成否に関わらず実況を完了へ (パネルの「実行中」を残さない)。TTL 経過で
      // ストアから消える。
      if (liveRef) {
        completeLiveView(session.id, id, liveRef);
        // ⚠**中止の印はここで消す** (@codex #357 P2)。この検索が終わった時点が
        // 印の役目の終わり。寿命を待ち時間から見積もる方式だと、有料取得の
        // 待ち行列が伸びたときに**中止したはずの検索が動き出す**。
        clearLiveViewCancel(session.id, id, liveRef);
      }
    }
  } catch (error) {
    return handleApiError(error);
  }
}
