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
import {
  runRegistryAutoFetch,
  getRegistryFetchProvider,
} from "@/lib/registry-fetch/auto-fetch";
import { loadRegistryFetchCredentials } from "@/lib/registry-fetch/config-store";
import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";
import {
  beginLiveView,
  reportLiveStep,
  attachLiveShot,
  completeLiveView,
  isValidLiveRef,
  closeLiveViewCancelWindow,
} from "@/lib/registry-fetch/live-view-store";

// ---------- POST /api/properties/[id]/registry/auto-fetch ----------
// 謄本自動取得（PR4・mock provider のみ）。本番外部接続・Playwright・課金・env 追加・
// 一括取得は無し。認証 → 権限（registry:auto_fetch + property:read）→ 入力受け口
// （confirmed）だけを担当し、取得・取込・registryStatus 遷移・AuditLog は
// runRegistryAutoFetch（@/lib/registry-fetch/auto-fetch）へ委譲する。
//
// body: { confirmed: true }  // 課金確認。true 以外は 400。
//
// CodexP1: 本番 provider 未実装の現状は provider 未設定として 501
// （REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED）で安全停止し、registryStatus / ImportJob /
// Attachment を一切変更しない（route は mock provider を new しない）。
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

    // registry:auto_fetch（admin のみ付与・課金を伴う高リスク操作）。
    if (!hasPermission(permissions, "registry", "auto_fetch")) {
      throw new ApiError(403, "謄本自動取得の権限がありません", "FORBIDDEN");
    }
    // 物件情報を読む既存権限も要求する（property:read）。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    // 課金確認フラグ。空ボディ / JSON 不正は parseJsonBody が安全に処理する。
    const body = await parseJsonBody(request);
    const confirmed = (body as { confirmed?: unknown }).confirmed === true;
    if (!confirmed) {
      throw new ApiError(
        400,
        "謄本自動取得には確認（confirmed:true）が必要です",
        "REGISTRY_AUTO_FETCH_CONFIRMATION_REQUIRED",
      );
    }

    // CodexP1: 本番 provider は未実装。route は mock provider を直接 new せず、解決した
    // provider が無ければ 501 で安全停止する。これにより mock 固定PDFで本番 DB
    // （registryStatus / ImportJob / Attachment）を更新する事故を防ぐ（mock 呼び出し・
    // DB 副作用は一切発生しない）。将来 PR で実 provider 実装後にこの経路が有効化される。
    // 資格情報は DB(設定画面)→env で解決して provider へ注入する。readiness(セレクタ校正)
    // 未達なら provider は null のまま=501(本番挙動不変・実サイトアクセスは起きない)。
    const credentials = await loadRegistryFetchCredentials();
    const provider = getRegistryFetchProvider({ credentials });
    if (!provider) {
      throw new ApiError(
        501,
        "謄本自動取得プロバイダは未設定です",
        "REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED",
      );
    }

    // 謄本の請求種別（owner=所有者事項/既定・all=全部事項）。不正値は既定 owner に倒す
    // （fail-safe: 未知の値で高い方を勝手に買わない）。
    const certRaw = (body as { certificateType?: unknown } | null)?.certificateType;
    const certificateType: "owner" | "all" = certRaw === "all" ? "all" : "owner";

    // 【回収】既に購入済みの謄本を、再課金なしで取り込むモード(2026-08-19)。
    // ⚠"recover" 以外の値は既定(有料取得)に倒さず**そのまま既定**=購入扱いにする
    //   のではなく、明示的に "recover" のときだけ回収にする(fail-safe: 不明値で
    //   勝手に課金経路へ落ちるのは避けたいが、既定は従来どおりの有料取得)。
    const modeRaw = (body as { mode?: unknown } | null)?.mode;
    // ⚠**知らない値は課金扱いにしない**(@codex #394 R2 P2)。打ち間違い("RECOVER"、
    //   末尾の空白など)が既定の有料取得へ落ちると、確認フラグは両方の導線が立てて
    //   いるため**意図しない課金**になり得る。未指定だけを従来どおり(有料取得)とし、
    //   値が入っているのに知らない値なら 400 で止める。
    if (modeRaw !== undefined && modeRaw !== null) {
      if (modeRaw !== "purchase" && modeRaw !== "recover") {
        throw new ApiError(
          400,
          "取得方法の指定が正しくありません",
          "REGISTRY_MODE_INVALID",
        );
      }
    }
    const isRecover = modeRaw === "recover";

    // 所在検索の候補を選んで取得する場合（candidateRef 指定）。cond③: client の候補参照は信頼せず、
    // server 側で当該物件向けに再検索して不動産番号を解決してから取得する。
    const candidateRefRaw = (body as { candidateRef?: unknown } | null)?.candidateRef;
    const candidateRef =
      typeof candidateRefRaw === "string" ? candidateRefRaw.trim() : "";

    if (candidateRef) {
      const { candidate, fingerprint } = await resolveRegistryCandidate({
        session: { id: session.id, role: session.role },
        propertyId: id,
        confirmed,
        candidateRef,
      });
      // 実況パネル(2026-08-15・任意)。検索 route と同じ橋渡しだが、**有料取得は中止を
      // 受け付けない**(課金だけ残る状態を作らない既存方針)ので、begin 直後に cancel 窓を
      // 閉じ、reporter にも isCancelRequested を配線しない。液晶に映る「中止」ボタンが
      // 効かないのに出ている、という食い違いを作らないため。
      const liveRefRaw = (body as { liveRef?: unknown } | null)?.liveRef;
      const liveRef =
        typeof liveRefRaw === "string" && isValidLiveRef(liveRefRaw)
          ? liveRefRaw
          : null;
      if (liveRef) {
        beginLiveView(session.id, id, liveRef);
        closeLiveViewCancelWindow(session.id, id, liveRef);
        reportLiveStep(
          session.id,
          id,
          liveRef,
          isRecover
            ? "取得済みの書類の取り込みを受け付けました(課金はしません)"
            : "自動取得を受け付けました(この処理は中止できません)",
          null,
        );
      }
      // ⚠**画面の写真は『全物件を見られる役割』にだけ渡す**(@codex #394 R2 P1)。
      //   自動操作は登記情報提供サービスの**マイページ(口座全体の履歴)**を開くため、
      //   全画面の写真には**他の物件の所在・受付番号**まで写る。担当分しか見られない
      //   役割(field_staff)に見せると、物件単位の認可を写真が素通りさせてしまう。
      //   文字の進行(固定文言)は誰でも見られるので、進み具合は分かる。
      const canSeeShots = !isPropertyScopedRole(session.role);
      if (liveRef && !canSeeShots) {
        reportLiveStep(
          session.id,
          id,
          liveRef,
          "この権限では画面の写真は記録しません(進行状況は文字でお伝えします)",
          null,
        );
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
          }
        : undefined;
      try {
        const obtained = await runRegistryAutoFetch(
          {
            session: { id: session.id, role: session.role },
            propertyId: id,
            confirmed,
            // 候補の種類で取得キーを分ける。number=従来の番号取得 /
            // location=段階②(2026-07-31)の有料請求→PDF取得(地番/家屋番号)。
            ...(candidate.kind === "number"
              ? { realEstateNumber: candidate.realEstateNumber }
              : {
                  locationCandidate: {
                    lotNumber: candidate.lotNumber,
                    buildingNumber: candidate.buildingNumber,
                  },
                  // 有料の所在取得のときだけ種別を渡す（番号取得は従来どおり無関係）。
                  certificateType,
                }),
            // @codex P2: lock する行の指紋が resolve 時と一致する時だけ override を使う。
            expectedFingerprint: fingerprint,
            // 回収は課金しない経路(スイッチ・二重課金ガードを通らない代わりに、
            // 請求済み・期限内の行しか取り込まない)。
            ...(isRecover ? ({ mode: "recover" } as const) : {}),
            live,
          },
          provider,
        );
        return apiResponse(obtained, 200);
      } finally {
        // 成否によらず「完了」を刻む(パネルは3分間の見返しつきで自動消滅)。
        if (liveRef) completeLiveView(session.id, id, liveRef);
      }
    }

    const result = await runRegistryAutoFetch(
      {
        session: { id: session.id, role: session.role },
        propertyId: id,
        confirmed,
      },
      provider,
    );

    return apiResponse(result, 200);
  } catch (error) {
    return handleApiError(error);
  }
}
