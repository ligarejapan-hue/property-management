// 追跡リンク(短縮URL/QR)に関する純関数群。
// URL に載せるのは opaque な trackingToken のみ(氏名・住所・物件ID 等の PII は載せない)。

export const TRACKING_PATH_PREFIX = "/t/";

// 環境変数 SALE_DM_TRACKING_BASE_URL を既定 base として読む薄いラッパ。
// 印刷物・QR には絶対URLが必要だが、base 未設定でも相対パスで動く(本番は設定必須)。
export function resolveTrackingBaseUrl(): string | undefined {
  const base = process.env.SALE_DM_TRACKING_BASE_URL;
  return base && base.trim().length > 0 ? base.trim() : undefined;
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
