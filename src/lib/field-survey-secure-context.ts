/**
 * 現地調査 (field-survey) の Geolocation API / camera capture は secure-context
 * (HTTPS もしくは localhost) でのみ安定動作する。LAN IP (http://192.168.x.x 等) を
 * 実機で開くと geolocation が silent fail しやすいため、insecure context を
 * 事前検知して UI 警告を出すかどうかを判定する純ロジック。
 *
 * - 副作用なし (window / navigator を参照しない)。呼び出し側が値を渡す。
 * - PII / 座標 / APIキー / hostname を console / 戻り値に流さない (boolean のみ返す)。
 * - 機能は止めない。あくまで表示用の警告フラグ。
 */

// ブラウザが http でも secure-context 扱いにする loopback host 群。
// IPv6 は bracket 付き ("[::1]") でも来るため両形を許容する。
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * hostname が loopback (localhost / 127.0.0.1 / ::1) かどうか。
 * 大文字小文字・前後空白・IPv6 bracket を吸収する。
 */
export function isLocalHostname(hostname: string | null | undefined): boolean {
  const h = (hostname ?? "").trim().toLowerCase();
  if (h.length === 0) return false;
  if (LOCAL_HOSTNAMES.has(h)) return true;
  // "[::1]" → "::1"
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  return LOCAL_HOSTNAMES.has(bare);
}

export interface SecureContextInput {
  /** window.isSecureContext (取得できない環境では undefined で渡す)。 */
  isSecureContext?: boolean;
  /** window.location.protocol 例: "https:" / "http:"。 */
  protocol: string;
  /** window.location.hostname 例: "localhost" / "192.168.0.10" / "example.com"。 */
  hostname: string;
}

/**
 * insecure context (= 位置情報/カメラが不安定になり得る環境) を警告すべきか。
 *
 * 警告しない条件 (いずれか):
 *  - hostname が loopback (localhost / 127.0.0.1 / ::1) — http でもブラウザが secure 扱い。
 *  - protocol が https:。
 *  - isSecureContext === true (file: / 信頼された埋め込み等の secure 扱い)。
 * 上記いずれにも当たらない (= http の LAN IP / 通常ドメイン等) なら警告する。
 *
 * 機能の強制停止はしない。表示判定のみ。
 */
export function shouldWarnInsecureContext(input: SecureContextInput): boolean {
  if (isLocalHostname(input.hostname)) return false;
  if ((input.protocol ?? "").trim().toLowerCase() === "https:") return false;
  if (input.isSecureContext === true) return false;
  return true;
}
