// 追跡リンク(短縮URL/QR)に関する純関数群。
// URL に載せるのは opaque な trackingToken のみ(氏名・住所・物件ID 等の PII は載せない)。
import { saleDmConfigFromEnv, type SaleDmResolvedConfig } from "./config";

export const TRACKING_PATH_PREFIX = "/t/";

// 絶対 http(s) URL のみ有効として返す共有ヘルパ。空/相対/非http は undefined(=未設定扱い)。
// 郵送QRの base も /t/ の遷移先 LP も、郵送先で機能するには絶対URLが必須なため共通化する。
function resolveAbsoluteHttpEnv(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined; // scheme/host の無い相対値(example.com, /app 等)は使えない。
  }
}

// 郵送QRの base(設定: trackingBaseUrl)。未設定/非絶対は undefined → print が 503 fail-closed。
// cfg は DB→env 解決済み。no-arg は env のみ(後方互換)。
export function resolveTrackingBaseUrl(cfg: SaleDmResolvedConfig = saleDmConfigFromEnv()): string | undefined {
  return resolveAbsoluteHttpEnv(cfg.trackingBaseUrl ?? undefined);
}

// 短縮URL /t/ の遷移先 既定LP(設定: lpUrl)。未設定/非絶対は undefined → /t/ は 404・print は 503。
// 参照するのは lpUrl だけ(Pick で受ける)。公開 /t は秘匿キーを含まない最小オブジェクトを渡せる。
export function resolveLpUrl(
  cfg: Pick<SaleDmResolvedConfig, "lpUrl"> = saleDmConfigFromEnv(),
): string | undefined {
  return resolveAbsoluteHttpEnv(cfg.lpUrl ?? undefined);
}

// 型ごとLP(DmVariant.lpUrl)が遷移先として使える絶対http(s) URLか。空/相対/非httpは false →
// route は既定LPへフォールバック(不正値で redirect しない・保存時に検証済みだが redirect 直前にも防御)。
export function isAbsoluteHttpUrl(raw: string | null | undefined): boolean {
  return resolveAbsoluteHttpEnv(raw ?? undefined) !== undefined;
}

/**
 * 宛先固有の追跡URLを組み立てる。
 *  - baseUrl 指定時: `<base>/t/<encoded token>`(base 末尾スラッシュは1つに正規化)
 *  - baseUrl 未指定時: 相対パス `/t/<encoded token>`
 * token は encodeURIComponent で安全化(PII/予期せぬ区切り文字を URL に漏らさない)。
 */
export function buildTrackingUrl(token: string, baseUrl?: string): string {
  const path = `${TRACKING_PATH_PREFIX}${encodeURIComponent(token)}`;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * 反響(問い合わせ)の導出: LP初回アクセス または 電話問い合わせ のいずれかがあれば「反響あり」。
 * 設計書「反響 = lpFirstAccessAt ∪ phoneInquiryAt」を単一の純関数に閉じ込め、
 * Plan 4(集計)と本プラン(LP記録)で同じ定義を共有する(導出のブレ防止)。
 */
export function isInquiryResponded(d: {
  lpFirstAccessAt?: Date | null;
  phoneInquiryAt?: Date | null;
}): boolean {
  return Boolean(d.lpFirstAccessAt) || Boolean(d.phoneInquiryAt);
}
