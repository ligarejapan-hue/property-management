/**
 * PR-2b-2: 謄本 所在検索オーケストレーション（add-only・検索ルートのみ）。
 *
 * 番号無し物件を所在/地番/家屋番号で謄本候補検索する中核。route から provider を注入して
 * 呼ばれ、戻り値がそのまま API レスポンス body になる。auto-fetch.ts の runRegistryAutoFetch に
 * 倣うが、取得（PDF 取得 / 楽観ロック / processRegistryPdf 接続）は行わず、
 * provider.searchCandidates 呼出に置換する（取得ルート拡張・UI は別スライス）。
 *
 * 秘匿情報（物件の所在地・地番・家屋番号・不動産番号）の扱い:
 *   - error / AuditLog には一切載せない（分類コード・件数・状態のみ／cond②）。
 *   - 応答 candidates から realEstateNumber を除外する（cond③: client から候補参照を信頼せず、
 *     取得時に server 側で当該物件向けに再解決する前提）。
 *   - 所有者PII（名前・住所）は入力にも応答にも含めない。
 *
 * provider は呼び出し側が必ず明示注入する（既定値なし）。本番は getRegistryFetchProvider() が
 * null を返すため route が 501 で安全停止する（実 provider 未実装・本番挙動不変／cond⑦）。
 */
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import type { RegistryPdfSession } from "@/lib/registry-pdf/process";
import {
  RegistryFetchError,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
} from "@/lib/registry-fetch";
import { buildRegistrySearchRequest } from "@/lib/registry-fetch/search-request";

export interface RunRegistrySearchArgs {
  /** 認証済みセッション（route の getApiSession から id/role のみ）。 */
  session: RegistryPdfSession;
  /** 検索対象物件ID（route path の {id}）。 */
  propertyId: string;
  /** 課金を伴う可能性があるため明示確認フラグ。true 以外は実行しない（cond①）。 */
  confirmed: boolean;
}

// provider 失敗（RegistryFetchError）の分類コード → 安全な HTTP ステータス。
// auto-fetch.ts の PROVIDER_ERROR_STATUS と同方針（外部本文・認証情報・PII は載せない）。
const PROVIDER_ERROR_STATUS: Readonly<Record<RegistryFetchErrorCode, number>> = {
  timeout: 504,
  rate_limited: 429,
  auth_failed: 502,
  not_found: 404,
  provider_error: 502,
};

/**
 * 所在検索の中核。route から呼ばれ、戻り値がそのまま API レスポンス body になる。
 * ハードエラーは ApiError を throw し、route 側 catch → handleApiError で HTTP 化する。
 *
 * provider は呼び出し側が必ず明示注入する（既定値なし）。
 */
export async function runRegistrySearch(
  args: RunRegistrySearchArgs,
  provider: RegistryFetchProvider,
): Promise<Record<string, unknown>> {
  const { session, propertyId, confirmed } = args;

  // 1. 確認フラグ必須（true 以外は DB / provider に一切到達しない／cond①）。
  //    route 側でも事前にガードするが、lib は直接呼出（テスト / 将来の別経路）からも
  //    独立して守るため再確認する（defense-in-depth・auto-fetch.ts と同方針）。
  if (confirmed !== true) {
    throw new ApiError(
      400,
      "謄本所在検索には確認（confirmed:true）が必要です",
      "REGISTRY_SEARCH_CONFIRMATION_REQUIRED",
    );
  }

  // 2. 対象物件の取得（検索キーの最小カラムのみ・所有者PIIは取得しない）。
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      createdBy: true,
      assignedTo: true,
      address: true,
      lotNumber: true,
      buildingNumber: true,
      realEstateNumber: true,
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }

  // 3. 物件スコープ（field_staff は担当/作成物件のみ）。物件詳細 API と同一方針。
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(
      403,
      "この物件にアクセスする権限がありません",
      "FORBIDDEN",
    );
  }

  // 4. 検索入力の組み立て（純関数）。不動産番号があれば検索不要・所在が無ければ検索不能。
  const built = buildRegistrySearchRequest({
    address: property.address,
    lotNumber: property.lotNumber,
    buildingNumber: property.buildingNumber,
    realEstateNumber: property.realEstateNumber,
    ref: property.id,
  });

  if (!built.searchable) {
    // 検索不能（has_real_estate_number / insufficient_location）。
    // provider には到達せず 200 で reason を返す（非PII 監査のみ）。
    await writeRegistrySearchAudit(session.id, propertyId, {
      status: "skipped",
      reason: built.reason,
    });
    return { searchable: false, reason: built.reason };
  }

  // 5. searchable: provider が検索に対応しなければ 501（型安全ガード）。
  //    本番は getRegistryFetchProvider() が null ゆえ route 側で先に 501 になる。
  if (typeof provider.searchCandidates !== "function") {
    throw new ApiError(
      501,
      "謄本所在検索プロバイダは未設定です",
      "REGISTRY_SEARCH_PROVIDER_NOT_CONFIGURED",
    );
  }

  try {
    const candidates = await provider.searchCandidates(built.request);

    // cond③: 応答から realEstateNumber を除外する（候補参照は取得時に server 再解決）。
    // 表示用フィールド（所在/地番/家屋番号）は認可ユーザー向け本文として返すが、
    // log / AuditLog には出さない。
    const shaped = candidates.map((c) => ({
      candidateRef: c.candidateRef,
      address: c.address ?? null,
      lotNumber: c.lotNumber ?? null,
      buildingNumber: c.buildingNumber ?? null,
    }));

    // 成功 AuditLog（非PII: 件数・状態のみ。所在/地番/不動産番号は載せない）。
    await writeRegistrySearchAudit(session.id, propertyId, {
      status: "success",
      candidateCount: candidates.length,
    });

    return { searchable: true, candidates: shaped };
  } catch (err) {
    // provider 失敗は安全な分類のみで応答（外部本文・認証情報・PII は載せない）。
    if (err instanceof RegistryFetchError) {
      await writeRegistrySearchAudit(session.id, propertyId, {
        status: "failed",
        providerErrorCode: err.code,
      });
      // err.message は RegistryFetchError の固定文言のみ（errors.ts 参照・
      // 外部レスポンス本文 / 認証情報 / PII を含まない）。
      throw new ApiError(
        PROVIDER_ERROR_STATUS[err.code],
        err.message,
        "REGISTRY_SEARCH_PROVIDER_ERROR",
      );
    }
    // それ以外（Prisma 例外等）はそのまま route の handleApiError に委ねる。
    throw err;
  }
}

/**
 * registry_search の AuditLog を書く（非PII の allowlist のみ）。
 * 所在/地番/家屋番号/不動産番号/所有者名・住所は載せない（cond②）。
 */
async function writeRegistrySearchAudit(
  userId: string,
  propertyId: string,
  extra: {
    status: "success" | "skipped" | "failed";
    reason?: string;
    candidateCount?: number;
    providerErrorCode?: RegistryFetchErrorCode;
  },
): Promise<void> {
  await writeAuditLog({
    userId,
    action: "registry_search",
    targetTable: "properties",
    targetId: propertyId,
    detail: {
      propertyId,
      confirmed: true,
      ...extra,
    },
  });
}
