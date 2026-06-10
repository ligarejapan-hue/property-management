/**
 * 住所補完 backend の共通型。
 *
 * 外部 API（日本郵便 郵便番号・デジタルアドレス API 等）の raw response は
 * そのまま外へ出さず、必ず {@link AddressLookupCandidate} へ整形して返す。
 * APIキー・トークン・raw payload は候補に含めない。
 */

/** client へ返す住所候補（外部 API の生レスポンスではなく整形済みの最小セット）。 */
export interface AddressLookupCandidate {
  /** 郵便番号（7桁・ハイフンなし。取得できなければ undefined） */
  postalCode?: string;
  /** 都道府県名 */
  prefecture?: string;
  /** 市区町村名 */
  city?: string;
  /** 町域名 */
  town?: string;
  /** 表示用の結合住所（prefecture + city + town を結合） */
  addressLine: string;
  /** どの provider が返したか（非PII の識別子。例: "japanpost" / "mock"） */
  source: string;
}

/**
 * 住所補完 provider の抽象。
 * 日本郵便 (JapanPostAddressProvider) / 開発用 (MockAddressLookupProvider) が実装する。
 *
 *  - 0件 → 空配列 []
 *  - 通信エラー / 認証失敗 / parse 失敗 → {@link AddressLookupError} を throw
 */
export interface AddressLookupProvider {
  /** provider 識別名（非PII。例: "japanpost"） */
  readonly name: string;
  /** 郵便番号(7桁・正規化済)から住所候補を引く。 */
  lookupByPostalCode(postalCode7: string): Promise<AddressLookupCandidate[]>;
  /** 住所文字列から郵便番号付き候補を検索する。 */
  searchByAddress(address: string): Promise<AddressLookupCandidate[]>;
}

/**
 * provider 内エラーの分類コード（安全な enum）。
 * route 側でこのコードを HTTP status へマップする（NOT_CONFIGURED→503 / それ以外→502）。
 * 外部レスポンス本文・APIキー・トークン・PII は message に含めない。
 */
export type AddressLookupErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "NETWORK"
  | "AUTH_FAILED"
  | "UPSTREAM_4XX"
  | "UPSTREAM_5XX"
  | "RATE_LIMITED"
  | "PARSE_ERROR";

/**
 * provider 内のエラーを統一する例外。
 * message には APIキー・トークン・外部 raw レスポンス・PII を入れない方針。
 */
export class AddressLookupError extends Error {
  readonly code: AddressLookupErrorCode;
  readonly httpStatus: number | null;

  constructor(
    code: AddressLookupErrorCode,
    message: string,
    httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "AddressLookupError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
