/**
 * 謄本自動取得 provider の安全な例外（PR3）。
 *
 * RegistryFetchError は **分類コード(RegistryFetchErrorCode) のみ** を受け取り、
 * メッセージはコードごとの固定の安全文言に限定する。これにより、外部レスポンス本文・
 * APIキー・認証トークン・所有者名・住所等の PII を例外に載せられない設計とする
 * （自由メッセージ引数を持たない）。実 provider は内部エラーをこのコードに分類して投げる。
 */
import type { RegistryFetchErrorCode } from "./types";

/**
 * コードごとの固定メッセージ（非PII・認証情報を含まない安全文言のみ）。
 * 外部サービスの生レスポンスや認証情報を埋め込まないこと。
 */
export const REGISTRY_FETCH_ERROR_MESSAGES: Readonly<
  Record<RegistryFetchErrorCode, string>
> = {
  timeout: "謄本取得サービスがタイムアウトしました。",
  rate_limited: "謄本取得サービスのレート制限に達しました。",
  auth_failed: "謄本取得サービスの認証に失敗しました。",
  not_found: "対象の謄本が見つかりませんでした。",
  provider_error: "謄本取得サービスでエラーが発生しました。",
  service_hours:
    "登記情報提供サービスは現在ご利用時間外です。利用時間(平日 8:30〜23:00・土日祝日 8:30〜18:00)内に再度お試しください。",
};

/**
 * provider 失敗を表す例外。code と固定メッセージのみを保持する。
 * 自由メッセージや外部詳細を受け取らないため、PII / 認証情報 / 生レスポンスは載らない。
 */
export class RegistryFetchError extends Error {
  /** 失敗分類コード（安全な enum）。 */
  readonly code: RegistryFetchErrorCode;

  constructor(code: RegistryFetchErrorCode) {
    super(REGISTRY_FETCH_ERROR_MESSAGES[code]);
    this.name = "RegistryFetchError";
    this.code = code;
  }
}
