/**
 * 謄本自動取得 provider 抽象のエントリポイント（PR3）。
 *
 * 将来の自動取得 API はここから provider 型と mock を import する。
 * 実 provider（外部接続）は別ファイルで本 interface を実装して追加する想定。
 */
export type {
  RegistryFetchRequest,
  RegistryFetchResult,
  RegistryFetchErrorCode,
  RegistryFetchProvider,
  RegistryCertificateType,
  RegistryLiveReporter,
} from "./types";
export { DEFAULT_CERTIFICATE_TYPE } from "./types";
export {
  RegistryFetchError,
  REGISTRY_FETCH_ERROR_MESSAGES,
} from "./errors";
export {
  MockRegistryFetchProvider,
  type MockRegistryFetchOptions,
} from "./mock-provider";
export {
  OfficialRegistryProvider,
  type OfficialRegistryProviderOptions,
  type RegistryBrowserPage,
  type RegistryBrowserFactory,
} from "./official-provider";
export {
  createRegistryFetchThrottle,
  type RegistryFetchThrottle,
  type RegistryFetchThrottleOptions,
} from "./throttle";
