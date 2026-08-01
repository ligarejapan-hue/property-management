/**
 * 逆ジオコーディング（座標 → 住居表示）orchestrator。
 *
 * env と NEXT_PUBLIC_USE_MOCK に応じて provider を切り替える。route 側はここだけを呼ぶ。
 *
 *   NEXT_PUBLIC_USE_MOCK=true              → MockReverseGeocodeProvider
 *   REVERSE_GEOCODE_PROVIDER が未設定      → ReverseGeocodeError("NOT_CONFIGURED")（route 503）
 *   REVERSE_GEOCODE_PROVIDER=gsi           → GsiReverseGeocodeProvider（国土地理院・無料・キー不要）
 *
 * ⚠既存規約（address-lookup と同型）: **env 未設定なら休眠(503)**。国土地理院はキー不要だが、
 * 「本番からの新しい外部接続はフラグ投入で明示的に有効化する」という運用を郵便番号補完と
 * 揃えるため、有効化フラグを必須にする。外部へ送るのは座標のみ（座標も保護対象の位置情報として扱い、UI で送信先を明示した上で利用者の明示操作時のみ送る）。
 */
import { GsiReverseGeocodeProvider } from "./gsi-provider";
import { MockReverseGeocodeProvider } from "./mock-provider";
import {
  ReverseGeocodeError,
  type ReverseGeocodeProvider,
  type ReverseGeocodeResult,
} from "./types";

export {
  ReverseGeocodeError,
  isPlausibleJapanCoordinate,
  type ReverseGeocodeResult,
  type ReverseGeocodeErrorCode,
  type ReverseGeocodeProvider,
} from "./types";
export { lookupMunicipality, parseGsiResponse } from "./gsi-provider";

/** 逆ジオコーディングが有効か（UI のボタン表示・事前チェック用）。 */
export function isReverseGeocodeConfigured(): boolean {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return true;
  return process.env.REVERSE_GEOCODE_PROVIDER === "gsi";
}

function resolveProvider(): ReverseGeocodeProvider {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") {
    return new MockReverseGeocodeProvider();
  }
  const providerName = process.env.REVERSE_GEOCODE_PROVIDER;
  if (providerName !== "gsi") {
    // 未設定・未知の値 → 休眠（fail-closed）。route が 503 にする。
    throw new ReverseGeocodeError("NOT_CONFIGURED");
  }
  return new GsiReverseGeocodeProvider();
}

/**
 * 座標から住所（町丁目まで）を引く。route から呼ぶ唯一の入口。
 * async にして NOT_CONFIGURED も常に rejection で返す（同期 throw と reject の混在を避ける）。
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult> {
  return resolveProvider().reverseGeocode(lat, lng);
}
