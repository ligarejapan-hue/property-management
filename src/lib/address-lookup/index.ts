/**
 * 住所補完 orchestrator。
 *
 * env と NEXT_PUBLIC_USE_MOCK に応じて provider を切り替える。route 側はこの関数だけを呼ぶ。
 *
 *   NEXT_PUBLIC_USE_MOCK=true                                   → MockAddressLookupProvider
 *   ADDRESS_LOOKUP_API_KEY / CLIENT_ID / BASE_URL のいずれか未設定 → AddressLookupError("NOT_CONFIGURED")（route 503）
 *   それ以外                                                      → ADDRESS_LOOKUP_PROVIDER（既定 japanpost）
 *
 * APIキー（ADDRESS_LOOKUP_API_KEY）は server-side のここでのみ読む。client には出さない。
 */

import {
  AddressLookupError,
  type AddressLookupCandidate,
  type AddressLookupProvider,
} from "./types";
import { JapanPostAddressProvider } from "./japanpost-provider";
import { MockAddressLookupProvider } from "./mock-provider";

export type {
  AddressLookupCandidate,
  AddressLookupProvider,
  AddressLookupErrorCode,
} from "./types";
export { AddressLookupError } from "./types";
export {
  normalizePostalCode,
  isValidPostalCode,
  formatPostalCode,
  normalizeAddress,
} from "./normalize";

/**
 * 住所補完 capability が有効か（env / mock）。UI のボタン disabled 判定や事前チェックに使う。
 */
export function isAddressLookupConfigured(): boolean {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return true;
  return (
    !!process.env.ADDRESS_LOOKUP_API_KEY &&
    !!process.env.ADDRESS_LOOKUP_CLIENT_ID &&
    !!process.env.ADDRESS_LOOKUP_BASE_URL &&
    !!process.env.ADDRESS_LOOKUP_SOURCE_IP
  );
}

function resolveProvider(): AddressLookupProvider {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") {
    return new MockAddressLookupProvider();
  }

  const providerName = process.env.ADDRESS_LOOKUP_PROVIDER ?? "japanpost";
  const secretKey = process.env.ADDRESS_LOOKUP_API_KEY;
  const clientId = process.env.ADDRESS_LOOKUP_CLIENT_ID;
  const baseUrl = process.env.ADDRESS_LOOKUP_BASE_URL;
  // 日本郵便の IP ベース認可で必須の登録済み送信元 IP（x-forwarded-for で送る）。
  const sourceIp = process.env.ADDRESS_LOOKUP_SOURCE_IP;

  // secret / client_id / base_url / source_ip のいずれか欠落で未構成扱い → route 503。
  if (!secretKey || !clientId || !baseUrl || !sourceIp) {
    throw new AddressLookupError(
      "NOT_CONFIGURED",
      "住所補完APIが設定されていません",
    );
  }

  const timeoutRaw = process.env.ADDRESS_LOOKUP_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;

  switch (providerName) {
    case "japanpost":
      return new JapanPostAddressProvider({
        clientId,
        secretKey,
        sourceIp,
        baseUrl,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      });
    default:
      throw new AddressLookupError(
        "NOT_CONFIGURED",
        `未対応の住所補完providerです: ${providerName}`,
      );
  }
}

/** 郵便番号（7桁・正規化済）→ 住所候補。未構成なら NOT_CONFIGURED を throw。 */
export async function lookupAddressByPostalCode(
  postalCode7: string,
): Promise<AddressLookupCandidate[]> {
  return resolveProvider().lookupByPostalCode(postalCode7);
}

/** 住所文字列 → 郵便番号付き候補。未構成なら NOT_CONFIGURED を throw。 */
export async function searchAddressByText(
  address: string,
): Promise<AddressLookupCandidate[]> {
  return resolveProvider().searchByAddress(address);
}
