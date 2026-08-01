/**
 * 逆ジオコーディングの mock provider（NEXT_PUBLIC_USE_MOCK=true / テスト用）。
 * 外部接続なしで決定的な結果を返す。demo で「取得できた/できなかった」両方を試せるよう、
 * 日本のもっともらしい座標なら固定住所・それ以外は found:false。
 */
import {
  isPlausibleJapanCoordinate,
  type ReverseGeocodeProvider,
  type ReverseGeocodeResult,
} from "./types";

export class MockReverseGeocodeProvider implements ReverseGeocodeProvider {
  readonly name = "mock";

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    if (!isPlausibleJapanCoordinate(lat, lng)) {
      return { found: false };
    }
    return {
      found: true,
      address: "東京都杉並区西荻北三丁目",
      town: "西荻北三丁目",
      municipalityCode: "13115",
    };
  }
}
