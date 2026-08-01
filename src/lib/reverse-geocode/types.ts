/**
 * 逆ジオコーディング（座標 → 住所=住居表示）の型。
 *
 * ⚠この機能が扱うのは**住居表示**（市区町村が付ける住所。例: 東京都杉並区西荻北三丁目）。
 * **地番**（登記の土地番号・`lotNumber`）は座標から引けないため対象外＝触らない。
 *
 * 無料API（国土地理院）は**町丁目まで**しか返さない（番・号は返らない）。
 * 第2弾で「番」まで返すローカル照合（address-blocks・国土交通省データ）を追加した。
 * どちらの精度で引けたかは precision で区別する（"block"=番まで / "town"=町丁目まで）。
 */

/** 逆ジオコーディングの結果。found:false は「その座標に対応する住所が無い」（海上・国外等）。 */
export type ReverseGeocodeResult =
  | {
      found: true;
      /** 組み立て済み住所。例「東京都杉並区西荻北3-1」(block) /「東京都杉並区西荻北三丁目」(town) */
      address: string;
      /** 町丁目。表示・デバッグ用。 */
      town: string;
      /** 精度: "block"=番まで(ローカル照合) / "town"=町丁目まで(国土地理院)。 */
      precision: "block" | "town";
      /** 市区町村コード（正規化済み・先頭ゼロなし）。town 精度(GSI由来)のみ。 */
      municipalityCode?: string;
    }
  | { found: false };

export interface ReverseGeocodeProvider {
  /** provider 識別名（非PII。例 "gsi" / "mock"）。 */
  readonly name: string;
  /**
   * 座標から住所を引く。失敗（ネットワーク・上流エラー）は ReverseGeocodeError を throw。
   * 「住所が無い」は throw ではなく found:false（正常な結果）。
   */
  reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult>;
}

export type ReverseGeocodeErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "NETWORK"
  | "UPSTREAM_ERROR"
  | "PARSE_ERROR";

/**
 * 逆ジオコーディングの安全な例外。コードと固定文言のみ（外部応答の生本文・座標を
 * メッセージに載せない）。
 */
export class ReverseGeocodeError extends Error {
  readonly code: ReverseGeocodeErrorCode;
  constructor(code: ReverseGeocodeErrorCode) {
    super(`reverse-geocode: ${code}`);
    this.name = "ReverseGeocodeError";
    this.code = code;
  }
}

/** 日本の座標としてもっともらしい範囲か（入力検証・上流への無駄打ち防止）。 */
export function isPlausibleJapanCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 20 &&
    lat <= 46 &&
    lng >= 122 &&
    lng <= 154
  );
}
