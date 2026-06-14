/**
 * 謄本自動取得連携 — 自動取得オーケストレーション（PR4・mock provider のみ）。
 *
 * PR1〜PR3 の部品を接続し、本番外部接続なしで「自動取得APIの骨格」を提供する:
 *   provider(mock) で謄本PDFを取得 → extractTextFromPdf → 既存の手動取込コア
 *   processRegistryPdf に流し込む（Mode A: path の {id} 物件を直接更新）。
 *
 * route.ts（POST handler）は認証・権限・入力受け口だけを担当し、本ファイルに
 *   - 課金 confirm 必須（confirmed:true 以外は実行しない）
 *   - 物件スコープ（canAccessPropertyRecord）
 *   - registryStatus 二重取得ガード（version 楽観ロックで scheduled 化）
 *   - provider 取得 → processRegistryPdf 接続
 *   - 成功時 obtained / 失敗時は元の status へロック解除
 *   - 非PII AuditLog
 * を集約する。手動取込（processRegistryPdf）の保存・Attachment(registry)・AuditLog 方針を
 * そのまま再利用し、新しい PII 保存先は増やさない。
 *
 * 今回は **mock provider のみ**。実 provider（外部サービス接続・Playwright・認証情報・課金・
 * env 追加）は一切実装しない。CodexP1: provider は呼び出し側が必ず明示注入する（既定値なし）。
 * live route は実 provider 未実装のため getRegistryFetchProvider() が null を返し、route が
 * 501 で安全停止する（mock は本番では使わず、テストでのみ runRegistryAutoFetch に注入する）。
 */
import type { RegistryStatus } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { extractTextFromPdf, isPdfBuffer } from "@/lib/pdf-extract";
import {
  processRegistryPdf,
  type RegistryPdfSession,
} from "@/lib/registry-pdf/process";
import {
  RegistryFetchError,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
} from "@/lib/registry-fetch";
import {
  OfficialRegistryProvider,
  type RegistryBrowserFactory,
} from "@/lib/registry-fetch/official-provider";

export interface RunRegistryAutoFetchArgs {
  /** 認証済みセッション（route の getApiSession から id/role のみ）。 */
  session: RegistryPdfSession;
  /** 取得対象物件ID（route path の {id}）。 */
  propertyId: string;
  /** 課金を伴う操作のため明示確認フラグ。true 以外は実行しない。 */
  confirmed: boolean;
}

// provider 失敗（RegistryFetchError）の分類コード → 安全な HTTP ステータス。
// 外部レスポンス本文・認証情報・PII は載せず、分類のみで応答する。
const PROVIDER_ERROR_STATUS: Readonly<Record<RegistryFetchErrorCode, number>> = {
  timeout: 504,
  rate_limited: 429,
  auth_failed: 502,
  not_found: 502,
  provider_error: 502,
};

/**
 * registryStatus を scheduled から元の値へ best-effort で戻す（ロック解除）。
 * まだ scheduled のときだけ戻し、並行更新を踏まない。解除失敗は握りつぶす
 * （元のエラーを優先するため）。
 */
async function releaseSchedulingLock(
  propertyId: string,
  previousStatus: RegistryStatus,
): Promise<void> {
  try {
    await prisma.property.updateMany({
      where: { id: propertyId, registryStatus: "scheduled" },
      data: { registryStatus: previousStatus },
    });
  } catch {
    // ロック解除失敗は記録のみ（元のエラーを優先）。
  }
}

/**
 * provider 解決のオプション。呼び出し側（PR-2 / テスト）が browserFactory を注入するための境界。
 * 本番 route / me-permissions は引数なしで呼ぶため、PR-1 では常に readiness=false（後述）。
 */
export interface ResolveRegistryFetchProviderOptions {
  /**
   * 実ブラウザ（Playwright）を起動する readiness の実体。これが渡されて初めて
   * 「実際に実取得が可能」= provider 解決可能とみなす。PR-2 でここに実 adapter を配線する。
   */
  browserFactory?: RegistryBrowserFactory;
}

/**
 * PR-1 で本番（引数なし呼び出し）が用いる browserFactory を解決する。
 *
 * CodexP2 の核心: 「env が設定されたら provider を返す」だけの解決は、browserFactory 未配線でも
 * 非null を返してしまい、capability=true → 有料ボタン有効化 → POST が 501 ガードをバイパスして
 * 物件を一瞬 scheduled にした後 OfficialRegistryProvider.fetchRegistryPdf() が必ず provider_error
 * を throw する（= 本番に常に失敗する操作の露出）。これを防ぐため、解決は **readiness（実際に
 * 実行可能か = browserFactory の有無）** に基づかせる。
 *
 * PR-1 では実 Playwright 起動 adapter を一切配線しない（playwright 依存追加なし）。よって本関数は
 * 常に undefined を返し、env が設定済みでも getRegistryFetchProvider() は null = 501 維持となる。
 * PR-2 でここに実 adapter を返す実装を入れると、env が揃った時点で capability=true になる。
 */
function resolveDefaultRegistryBrowserFactory():
  | RegistryBrowserFactory
  | undefined {
  // PR-1: 実ブラウザ起動境界は未配線 = 実取得不能 = readiness なし。
  return undefined;
}

/**
 * 本番で使用する謄本取得 provider を解決する。
 *
 * CodexP1: env フラグで provider を切替えず、資格情報（REGISTRY_FETCH_LOGIN_ID/PASSWORD）で解決する。
 * CodexP2: さらに **readiness（browserFactory の有無 = 実取得が実際に可能か）** を解決条件に加える。
 *   - 資格情報が揃い かつ readiness（browserFactory）が揃って初めて実 provider を返す。
 *   - いずれか欠ければ null（= route 501 維持）。throw でなく null を返し、既存の 501 null 契約を
 *     温存する（住所補完 resolveProvider() は 503 throw だが、registry は 501 null 契約を変えない）。
 *
 * 秘密管理: REGISTRY_FETCH_* は **この関数内でのみ** 読む（server-side のみ・NEXT_PUBLIC 禁止）。
 *
 * PR-1 scaffold の安全性: 本番は引数なしで呼ぶ → readiness（browserFactory）は
 * resolveDefaultRegistryBrowserFactory() が undefined を返す（PR-1 では実 adapter 未配線）→ 常に
 * null = 501 維持で本番挙動は不変（env を設定しても scheduled にせず・有料ボタンも無効）。
 * PR-2 で resolveDefaultRegistryBrowserFactory() に実 adapter を入れる（または呼び出し側が
 * browserFactory を注入する）と、env が揃った時点で capability=true になる。
 */
export function getRegistryFetchProvider(
  options: ResolveRegistryFetchProviderOptions = {},
): RegistryFetchProvider | null {
  const loginId = process.env.REGISTRY_FETCH_LOGIN_ID;
  const password = process.env.REGISTRY_FETCH_PASSWORD;

  // 資格情報のいずれか欠落 → null（= route 501 維持 = 本番挙動不変）。
  if (!loginId || !password) {
    return null;
  }

  // CodexP2: readiness（browserFactory）が無ければ実取得不能 → null（= 501 維持）。
  // PR-1 では default factory が undefined ゆえ、env 設定済みでもここで null になる。
  const browserFactory =
    options.browserFactory ?? resolveDefaultRegistryBrowserFactory();
  if (!browserFactory) {
    return null;
  }

  const baseUrl = process.env.REGISTRY_FETCH_BASE_URL || undefined;
  const timeoutRaw = process.env.REGISTRY_FETCH_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;

  return new OfficialRegistryProvider({
    loginId,
    password,
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    browserFactory,
  });
}

/**
 * UI の capability 表示用 read-only ヘルパ。本番 provider が解決できるか（= 設定済み かつ
 * 実取得可能 = readiness 充足か）を boolean だけで返す。secret・設定値そのもの・PII は返さない。
 * 副作用・外部接続・env 追加なし。
 *
 * CodexP2: env 設定済みでも browserFactory 未配線（PR-1）なら false を返す。これにより
 * /api/me/permissions の capabilities.registryAutoFetch が false となり、有料の自動取得ボタンは
 * 無効・POST は 501 維持となる（「設定済みなのに常に失敗する操作」を露出しない）。
 */
export function isRegistryAutoFetchProviderConfigured(
  options: ResolveRegistryFetchProviderOptions = {},
): boolean {
  return getRegistryFetchProvider(options) != null;
}

/**
 * 自動取得の中核。route から呼ばれ、戻り値がそのまま API レスポンス body になる。
 * ハードエラーは ApiError を throw し、route 側 catch → handleApiError で HTTP 化する。
 *
 * CodexP1: provider は呼び出し側が必ず明示注入する（既定値なし）。これにより live route が
 * provider を渡さずに mock を暗黙利用して本番 DB を壊すことを型レベルで防ぐ。
 */
export async function runRegistryAutoFetch(
  args: RunRegistryAutoFetchArgs,
  provider: RegistryFetchProvider,
): Promise<Record<string, unknown>> {
  const { session, propertyId, confirmed } = args;

  // 1. 課金 confirm 必須（true 以外は一切実行しない）。
  if (confirmed !== true) {
    throw new ApiError(
      400,
      "謄本自動取得には確認（confirmed:true）が必要です",
      "REGISTRY_AUTO_FETCH_CONFIRMATION_REQUIRED",
    );
  }

  // 2. 対象物件の取得（非PIIの最小カラムのみ）。
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      createdBy: true,
      assignedTo: true,
      registryStatus: true,
      version: true,
      realEstateNumber: true,
    },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }

  // 3. 物件スコープ（field_staff は担当/作成物件のみ）。既存 Mode A と同じ 403 方針。
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(
      403,
      "この物件にアクセスする権限がありません",
      "FORBIDDEN",
    );
  }

  // 4. 二重取得ガード（早期）: 既に scheduled なら 409。
  if (property.registryStatus === "scheduled") {
    throw new ApiError(
      409,
      "この物件は既に謄本自動取得を実行中です",
      "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    );
  }

  // 5. 楽観ロック取得: version 一致 かつ まだ scheduled でない物件だけを scheduled にする。
  //    count===0 は並行取得 or バージョン変化 → 409（二重実行させない）。
  const previousStatus = property.registryStatus;
  const lock = await prisma.property.updateMany({
    where: {
      id: propertyId,
      version: property.version,
      registryStatus: { not: "scheduled" },
    },
    data: { registryStatus: "scheduled", version: { increment: 1 } },
  });
  if (lock.count === 0) {
    throw new ApiError(
      409,
      "この物件は既に謄本自動取得を実行中です",
      "REGISTRY_AUTO_FETCH_ALREADY_RUNNING",
    );
  }

  // 6. provider 取得 → PDF 検証 → text 抽出 → processRegistryPdf 接続 → 成功 status。
  //    いずれの失敗でも scheduled で固着させないよう、catch で必ずロック解除する。
  try {
    // 取得キーは非PIIのみ（realEstateNumber / 物件UUID）。所有者名・住所は渡さない。
    const fetchResult = await provider.fetchRegistryPdf({
      realEstateNumber: property.realEstateNumber,
      ref: property.id,
    });

    // 取得物が PDF でなければ取込に進まない（real provider 差し替え時の防御）。
    if (!isPdfBuffer(fetchResult.pdfBuffer)) {
      throw new ApiError(
        422,
        "取得した謄本がPDFではありません",
        "REGISTRY_AUTO_FETCH_INVALID_PDF",
      );
    }

    // 手動 multipart 取込と同じ抽出器を使う（pdf-parse）。
    let text: string;
    try {
      text = await extractTextFromPdf(fetchResult.pdfBuffer);
    } catch {
      throw new ApiError(
        422,
        "取得した謄本PDFのテキスト抽出に失敗しました",
        "REGISTRY_AUTO_FETCH_PDF_PARSE_FAILED",
      );
    }

    // 既存の手動取込コアへ接続（Mode A: 対象物件を直接更新）。ImportJob 作成・
    // Attachment(type="registry") 保存・pdf_import AuditLog（非PII）は processRegistryPdf
    // 側の既存方針をそのまま再利用する（新しい PII 保存先は増やさない）。
    const result = await processRegistryPdf({
      session,
      text,
      propertyId,
      fileName: fetchResult.fileName,
      edited: undefined,
      pdfBuffer: fetchResult.pdfBuffer,
    });

    // 成功 → scheduled から obtained へ確定。
    await prisma.property.update({
      where: { id: propertyId },
      data: { registryStatus: "obtained", version: { increment: 1 } },
    });

    // 成功 AuditLog（非PII のみ）。PDF本文/抽出テキスト/所有者名・住所/郵便番号/
    // fileUrl 全文/APIキー/credential/raw レスポンスは載せない。件数・ID・分類のみ。
    await writeAuditLog({
      userId: session.id,
      action: "registry_auto_fetch",
      targetTable: "properties",
      targetId: propertyId,
      detail: {
        propertyId,
        jobId: result.jobId,
        ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
        source: fetchResult.source,
        providerRequestId: fetchResult.providerRequestId,
        fetchedAt: fetchResult.fetchedAt.toISOString(),
        status: "success",
        action: result.action,
        ownersMatched: result.ownersMatched ?? 0,
        ownersCreated: result.ownersCreated ?? 0,
        ownersLinked: result.ownersLinked ?? 0,
        confirmed: true,
      },
    });

    // レスポンス body（非PII の allowlist）。
    // CodexP2: processRegistryPdf の戻り値 result には parsed（謄本由来の owner 名・住所・
    // realEstateNumber 等の PII）が含まれる。本 API は registry:auto_fetch + property:read で
    // 実行でき owner:read を要求しないため、result を spread して parsed を返すと既存の
    // owner:read 制御（物件詳細 API の owner PII マスキング）を迂回して owner PII を漏らす。
    // よって result は spread せず、非PII の項目だけを明示的に拾って返す。所有者名/住所/
    // 郵便番号/抽出テキスト/PDF本文/fileUrl 全文は返さない（手動取込APIのレスポンスは不変）。
    return {
      jobId: result.jobId,
      action: result.action,
      status: "success",
      propertyId: result.propertyId,
      ownersMatched: result.ownersMatched,
      ownersCreated: result.ownersCreated,
      ownersLinked: result.ownersLinked,
      ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
      source: fetchResult.source,
      fileName: fetchResult.fileName,
      providerRequestId: fetchResult.providerRequestId,
      fetchedAt: fetchResult.fetchedAt.toISOString(),
      registryStatus: "obtained",
      confirmed: true,
    };
  } catch (err) {
    // 失敗 → ロック解除（previousStatus へ戻す）。best-effort・元のエラー優先。
    await releaseSchedulingLock(propertyId, previousStatus);

    // provider 失敗は安全なレスポンスにマップ（分類コードのみ・PII/認証情報/生レスポンスなし）。
    if (err instanceof RegistryFetchError) {
      // 失敗 AuditLog（非PII: 分類コードのみ）。
      await writeAuditLog({
        userId: session.id,
        action: "registry_auto_fetch",
        targetTable: "properties",
        targetId: propertyId,
        detail: {
          propertyId,
          source: provider.name,
          status: "failed",
          providerErrorCode: err.code,
          confirmed: true,
        },
      });
      throw new ApiError(
        PROVIDER_ERROR_STATUS[err.code],
        err.message,
        "REGISTRY_AUTO_FETCH_PROVIDER_ERROR",
      );
    }

    // それ以外（extract 失敗の ApiError(422) / processRegistryPdf の ApiError / Prisma 例外）は
    // そのまま再 throw して route の handleApiError に正規の HTTP を返させる。
    throw err;
  }
}
