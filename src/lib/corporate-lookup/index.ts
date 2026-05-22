// 法人番号 lookup orchestrator。
// env と NEXT_PUBLIC_USE_MOCK の状態に応じて provider を切り替える。
//
//   NEXT_PUBLIC_USE_MOCK=true                       → MockCorporateLookupProvider
//   CORPORATE_NUMBER_API_APP_ID 未設定               → CorporateLookupError("NOT_CONFIGURED")
//   それ以外                                          → NtaProvider
//
// route 側はこの関数だけを呼べばよい。

import { CorporateLookupError, type CorporateLookupResult } from "./types";
import { NtaProvider } from "./nta-provider";
import { MockCorporateLookupProvider } from "./mock-provider";

export type {
  CorporateLookupResult,
  CorporateLookupRecord,
  CorporateLookupProvider,
} from "./types";
export { CorporateLookupError } from "./types";

/**
 * 法人番号 lookup capability が有効か（env 設定 / mock）を返す。
 * UI の検索ボタン disabled 判定に使う。
 */
export function isCorporateLookupConfigured(): boolean {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return true;
  return !!process.env.CORPORATE_NUMBER_API_APP_ID;
}

/**
 * 13桁正規化済の法人番号で lookup を行う。
 * 13桁チェックは呼び出し側で実施しておくこと（route で normalizeCorporateNumber する）。
 */
export async function lookupCorporateNumber(
  corporateNumber13: string,
): Promise<CorporateLookupResult> {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") {
    return new MockCorporateLookupProvider().lookup(corporateNumber13);
  }

  const appId = process.env.CORPORATE_NUMBER_API_APP_ID;
  if (!appId) {
    throw new CorporateLookupError("NOT_CONFIGURED", "法人番号APIが設定されていません");
  }

  const url = process.env.CORPORATE_NUMBER_API_URL;
  const timeoutMsRaw = process.env.CORPORATE_NUMBER_API_TIMEOUT_MS;
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : undefined;

  const provider = new NtaProvider({
    appId,
    url,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });
  return provider.lookup(corporateNumber13);
}
