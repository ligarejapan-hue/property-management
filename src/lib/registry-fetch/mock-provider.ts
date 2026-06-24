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
  RegistrySearchRequest,
  RegistryCandidate,
} from "./types";
import { RegistryFetchError } from "./errors";

/**
 * mock が返す既定の最小 PDF（外部アクセスなし・ソース内完結の固定 base64）。
 *
 * Codex P2: 旧実装は "%PDF-" の magic は満たすが PDF 構造として無効で、
 * extractTextFromPdf(pdf-parse) が InvalidPDFException で失敗していた。本 fixture は
 * 1ページ・テキストのみの最小の「有効な」PDF で、pdf-parse が parse でき本文
 * "REGISTRY AUTO FETCH MOCK PDF" を抽出できる。
 *
 * 外部ファイル/HTTP/FS は使わず base64 文字列としてソース内に固定する。実際の謄本
 * サンプルや著作物ではなく、所有者名/住所/郵便番号/APIキー/認証情報など PII・secret は
 * 一切含まない。
 */
const DEFAULT_MOCK_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2Jq" +
  "CjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2Jq" +
  "CjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIg" +
  "NzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAw" +
  "IFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRm" +
  "IDcyIDcwMCBUZCAoUkVHSVNUUlkgQVVUTyBGRVRDSCBNT0NLIFBERikgVGogRVQKZW5kc3RyZWFt" +
  "CmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQg" +
  "L0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAw" +
  "MDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAw" +
  "MDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTAgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9S" +
  "b290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjAKJSVFT0YK";
const DEFAULT_MOCK_PDF = Buffer.from(DEFAULT_MOCK_PDF_BASE64, "base64");

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
  /** searchCandidates が返す候補を注入できる（未指定なら request から決定的に導出）。 */
  candidates?: RegistryCandidate[];
  /**
   * 指定すると searchCandidates が常にこの分類コードの RegistryFetchError を投げる。
   * 検索エラー経路のテスト用（fetch の failWith とは独立）。
   */
  searchFailWith?: RegistryFetchErrorCode;
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

  /**
   * 所在検索の mock（PR-2b・外部 I/O なし）。注入された候補、または request から決定的に
   * 1 候補を導出して返す。秘匿情報（所在/地番/家屋番号）はそのまま echo するだけで、log 等には出さない。
   */
  async searchCandidates(
    request: RegistrySearchRequest,
  ): Promise<RegistryCandidate[]> {
    if (this.options.searchFailWith) {
      throw new RegistryFetchError(this.options.searchFailWith);
    }
    if (this.options.candidates) {
      return this.options.candidates;
    }
    // request から決定的に導出（同一入力 → 同一候補）。ref（非PII）を候補参照に使う。
    const ref = request.ref ?? "default";
    return [
      {
        candidateRef: `mock-candidate-${ref}`,
        address: request.address,
        lotNumber: request.lotNumber ?? null,
        buildingNumber: request.buildingNumber ?? null,
        realEstateNumber: `MOCK-${ref}`,
      },
    ];
  }
}
