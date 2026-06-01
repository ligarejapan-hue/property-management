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
 * env 追加）は一切実装しない。provider は引数で注入でき、既定は MockRegistryFetchProvider。
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
  MockRegistryFetchProvider,
  RegistryFetchError,
  type RegistryFetchProvider,
  type RegistryFetchErrorCode,
} from "@/lib/registry-fetch";

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
 * 自動取得の中核。route から呼ばれ、戻り値がそのまま API レスポンス body になる。
 * ハードエラーは ApiError を throw し、route 側 catch → handleApiError で HTTP 化する。
 *
 * provider は注入可能（既定は外部接続しない MockRegistryFetchProvider）。
 */
export async function runRegistryAutoFetch(
  args: RunRegistryAutoFetchArgs,
  provider: RegistryFetchProvider = new MockRegistryFetchProvider(),
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

    // レスポンス body。processRegistryPdf 結果に provider メタ（非PII）と確定 status を付与。
    // result には parsed（手動取込と同じく呼び出し元へ返す）も含まれるが、AuditLog には
    // 載せていない（監査の非PII方針は上の writeAuditLog で担保）。
    return {
      ...result,
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
