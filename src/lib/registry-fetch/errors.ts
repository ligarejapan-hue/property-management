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
  // ⚠**「候補0件」と言い切らない**。サイトが所在の指定を拒否した状態で、
  // 実際には登記が存在する可能性が高い。原因と次の手を書く。
  // ⚠所在そのものは載せない(固定文言=PIIを載せない設計を守る)。
  location_rejected:
    "登記情報提供サービスが所在の指定を受け付けませんでした。物件の住所に地番(例「1-1」)まで含まれている、旧字体などの外字が含まれている、といった場合に起きます。住所を「丁目まで」に整え、地番は地番欄へ入れて再度お試しください。",
  provider_error: "謄本取得サービスでエラーが発生しました。",
  service_hours:
    "登記情報提供サービスは現在ご利用時間外です。利用時間(平日 8:30〜23:00・土日祝日 8:30〜18:00)内に再度お試しください。",
  service_unavailable:
    "登記情報提供サービスに接続できませんでした。ご利用時間外(平日 8:30〜23:00・土日祝日 8:30〜18:00)の可能性があります。利用時間内の場合は、しばらくおいて再度お試しください。",
  charged_but_failed:
    "謄本の請求は完了しましたが、その後の取得に失敗しました。課金が発生している可能性があります。再実行せず、登記情報提供サービスのマイページで請求状態をご確認ください。",
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
