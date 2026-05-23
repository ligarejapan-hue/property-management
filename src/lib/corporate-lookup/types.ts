// 法人番号 lookup adapter の共通型。
// Phase B: preview のみ。DB 反映は Phase C（corporate-apply）で扱う。

/**
 * 国税庁 法人番号 Web-API から取得する preview 用フィールド。
 * raw XML / postCode 生値以外の PII 系は保存しない方針なので、
 * UI に出す最小セットだけを定義する。
 */
export interface CorporateLookupRecord {
  /** 13桁法人番号（リクエストで投げた値と一致する想定） */
  corporateNumber: string;
  /** 法人名 */
  name: string;
  /** フリガナ（未取得時 null） */
  furigana: string | null;
  /** 所在地（prefectureName + cityName + streetNumber を結合） */
  address: string;
  /** 都道府県名（個別表示用） */
  prefectureName: string | null;
  /** 市区町村名 */
  cityName: string | null;
  /** 番地等 */
  streetNumber: string | null;
  /** 郵便番号（7桁・ハイフンなし。取得できなければ null） */
  postCode: string | null;
  /** 更新年月日 (YYYY-MM-DD) */
  updateDate: string | null;
}

/**
 * lookup の戻り値。found=false の場合は record を返さない。
 * 廃止法人は found=true + isClosed=true で返す。
 */
export interface CorporateLookupResult {
  found: boolean;
  /** 廃止法人かどうか（found=true のときのみ意味を持つ） */
  isClosed: boolean;
  /** 廃止年月日 (YYYY-MM-DD) — found=true かつ isClosed=true のときのみ非 null */
  closeDate: string | null;
  /** 廃止事由コード — closeDate と同様 */
  closeCause: string | null;
  /** found=true のときに非 null */
  record: CorporateLookupRecord | null;
  /** 結果取得 ISO timestamp */
  fetchedAt: string;
  /** どの provider が返したか */
  source: string;
}

/**
 * Adapter の共通インタフェース。
 * 国税庁 (NtaProvider) / 開発用 (MockProvider) はこれを実装する。
 *
 * lookup() は:
 *   - 0件 → { found: false, record: null }
 *   - 廃止法人 → { found: true, isClosed: true, record: {...} }
 *   - 通信エラー / parse 失敗 → CorporateLookupError を throw
 */
export interface CorporateLookupProvider {
  readonly name: string;
  lookup(corporateNumber13: string): Promise<CorporateLookupResult>;
}

/**
 * provider 内のエラーを統一する。route 側で ApiError(502 or 503) にマップする。
 * 生値（法人番号 / 会社名 / 住所 / raw XML）は message に含めない方針。
 */
export class CorporateLookupError extends Error {
  readonly code:
    | "NOT_CONFIGURED"
    | "TIMEOUT"
    | "NETWORK"
    | "UPSTREAM_4XX"
    | "UPSTREAM_5XX"
    | "RATE_LIMITED"
    | "PARSE_ERROR";
  readonly httpStatus: number | null;

  constructor(
    code: CorporateLookupError["code"],
    message: string,
    httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "CorporateLookupError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
