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
import {
  runRegistryAutoFetch,
  getRegistryFetchProvider,
} from "@/lib/registry-fetch/auto-fetch";
import { loadRegistryFetchCredentials } from "@/lib/registry-fetch/config-store";
import { resolveRegistryCandidate } from "@/lib/registry-fetch/search";

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
              }),
          // @codex P2: lock する行の指紋が resolve 時と一致する時だけ override を使う。
          expectedFingerprint: fingerprint,
        },
        provider,
      );
      return apiResponse(obtained, 200);
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
