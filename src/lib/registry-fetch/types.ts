/**
 * 謄本自動取得連携 — provider 抽象（PR3）。
 *
 * 外部の登記情報提供サービス等から謄本PDFを取得する処理を抽象化する interface。
 * 将来の `POST /api/properties/{id}/registry/auto-fetch` が provider を注入して呼び、
 * 取得した pdfBuffer を既存の手動取込コア（processRegistryPdf）に流し込む想定。
 *
 * 本 PR では **interface と mock provider のみ** を追加し、実 provider（外部接続・
 * Playwright・認証情報・課金・env）は一切実装しない。mock は外部I/Oに触れない。
 */

/**
 * 取得対象の指定（非PII の検索キー）。
 * 実 provider が外部サービスへ問い合わせるための最小情報。所有者名・住所等の PII は含めない。
 */
export interface RegistryFetchRequest {
  /** 不動産番号（最も一意。あれば最優先で使用）。 */
  realEstateNumber?: string | null;
  /**
   * トレース用の非PII参照ラベル（例: ImportJobId / 物件UUID）。
   * 所有者名・住所等の PII を入れてはならない。
   */
  ref?: string | null;
}

/**
 * 取得成功結果。pdfBuffer は手動 multipart 取込と同じ Buffer で、そのまま
 * processRegistryPdf({ pdfBuffer, ... }) に渡せる形にする。
 */
export interface RegistryFetchResult {
  /** 取得した謄本PDFのバイト列。 */
  pdfBuffer: Buffer;
  /** 保存・監査用ファイル名（非PII）。 */
  fileName: string;
  /** 取得元 provider の識別子（非PII。例: "mock"）。 */
  source: string;
  /** 取得時刻。 */
  fetchedAt: Date;
  /**
   * provider 側リクエストの非PII識別子（監査/トレース用）。
   * APIキー・認証トークン・外部レスポンス本文・PII は含めない。
   */
  providerRequestId: string;
}

/**
 * provider エラーの分類コード（安全な enum）。
 * 外部レスポンス本文・認証情報・PII を含めず、この分類のみで上位へ伝える。
 */
export type RegistryFetchErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth_failed"
  | "not_found"
  | "provider_error";

/**
 * 謄本PDF取得 provider の抽象。実 provider（外部サービス接続）は将来差し替える。
 * 失敗時は RegistryFetchError（分類コードのみを持つ安全な例外）を throw する。
 */
export interface RegistryFetchProvider {
  /** provider の識別名（非PII。例: "mock"）。 */
  readonly name: string;
  /** 謄本PDFを取得する。失敗時は RegistryFetchError を throw。 */
  fetchRegistryPdf(request: RegistryFetchRequest): Promise<RegistryFetchResult>;
}
