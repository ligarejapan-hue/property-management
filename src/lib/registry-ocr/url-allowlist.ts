/**
 * REGISTRY_OCR_URL の strict localhost allowlist。
 *
 * OCR サービスは VPS 上の localhost 専用（謄本=高 PII ゆえ外部送信を構造的に禁止）。
 * env で渡される URL を検証し、loopback 以外（外部ドメイン / https / LAN・private IP /
 * 任意ホスト / 資格情報埋め込み）をすべて拒否する。
 *
 * 既存コードに汎用 SSRF ガードが無いため本ファイルで新設する
 * （field-survey-secure-context の isLocalHostname は warning 用途のみで enforcement ではない）。
 */

// 許可する loopback ホスト（完全一致のみ）。
// 127.0.0.1.evil.com / localhost.evil.com 等の suffix 偽装は集合非一致で弾かれる。
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * raw URL が許可された localhost OCR エンドポイントなら URL を返す。
 * 不許可・不正・空はすべて null（呼び出し側で「未設定扱い」＝fail-closed）。
 *
 *  - protocol は http: のみ（https・その他は egress 防止の主旨に反するため不可）
 *  - hostname は 127.0.0.1 / localhost のみ（::1・LAN・private IP・任意ホストは不可）
 *  - username / password の埋め込みは不可
 */
export function parseLocalhostOcrUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // URL.hostname は IPv6 を角括弧なしで返す。許可集合との完全一致のみ通す。
  if (!ALLOWED_HOSTNAMES.has(url.hostname)) return null;
  // 契約は POST /ocr のみ。env typo で同一ホスト上の別サービス（例: アプリ自身の
  // http://127.0.0.1:3000/...）へ謄本 PDF を送らないよう path を固定し、query/hash も拒否する。
  if (url.pathname !== "/ocr") return null;
  if (url.search !== "" || url.hash !== "") return null;
  return url;
}

/** 許可された localhost OCR URL かどうか（boolean）。 */
export function isLocalhostOcrUrl(raw: string | null | undefined): boolean {
  return parseLocalhostOcrUrl(raw) !== null;
}
