/**
 * 謄本自動取得 provider の mock 実装（PR3）。
 *
 * - 外部 HTTP / ブラウザ(Playwright) / ファイルシステム / 認証情報 に一切アクセスしない。
 * - 固定の最小 PDF バイト列、またはテスト/開発から注入された pdfBuffer を返すだけ。
 * - failWith オプションでエラー経路（RegistryFetchError）の検証もできる。
 * - 実 provider（外部接続）は将来この interface を実装して差し替える。
 */
import type {
  RegistryFetchProvider,
  RegistryFetchRequest,
  RegistryFetchResult,
  RegistryFetchErrorCode,
} from "./types";
import { RegistryFetchError } from "./errors";

/** mock が返す既定の最小 PDF バイト列（外部アクセスなし・固定値）。 */
const DEFAULT_MOCK_PDF = Buffer.from("%PDF-1.4\n%mock registry pdf\n%%EOF\n", "utf8");

export interface MockRegistryFetchOptions {
  /** 返す PDF バイト列を注入できる（未指定なら固定の最小バッファ）。 */
  pdfBuffer?: Buffer;
  /** 返すファイル名（既定 "registry-mock.pdf"）。 */
  fileName?: string;
  /** 返す source ラベル（既定 "mock"）。 */
  source?: string;
  /**
   * 指定すると fetchRegistryPdf が常にこの分類コードの RegistryFetchError を投げる。
   * エラー経路のテスト用。
   */
  failWith?: RegistryFetchErrorCode;
  /** fetchedAt をテストから固定するための注入（未指定なら呼び出し時刻）。 */
  now?: Date;
  /** providerRequestId をテストから固定するための注入。 */
  providerRequestId?: string;
}

/**
 * 外部接続を行わない mock provider。固定値 or 注入値のみを返す。
 */
export class MockRegistryFetchProvider implements RegistryFetchProvider {
  readonly name = "mock";

  private readonly options: MockRegistryFetchOptions;

  constructor(options: MockRegistryFetchOptions = {}) {
    this.options = options;
  }

  async fetchRegistryPdf(
    request: RegistryFetchRequest,
  ): Promise<RegistryFetchResult> {
    // 外部 I/O は一切行わない。注入値 or 固定値を同期的に組み立てて返すだけ。
    if (this.options.failWith) {
      throw new RegistryFetchError(this.options.failWith);
    }

    const pdfBuffer = this.options.pdfBuffer ?? DEFAULT_MOCK_PDF;
    // providerRequestId は非PII。指定が無ければ request.ref（非PII）から導出する。
    const providerRequestId =
      this.options.providerRequestId ?? `mock-${request.ref ?? "default"}`;

    return {
      pdfBuffer,
      fileName: this.options.fileName ?? "registry-mock.pdf",
      source: this.options.source ?? this.name,
      fetchedAt: this.options.now ?? new Date(),
      providerRequestId,
    };
  }
}
