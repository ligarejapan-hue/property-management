/**
 * maps-url.ts — 物件住所から Google マップ検索 URL を組み立てる純関数。
 * 地図QR(物件の場所へのリンクを QR 化)で使う。
 */

/**
 * 住所を Google マップの検索 URL にする(公式の Maps URL スキーム）。
 * `https://www.google.com/maps/search/?api=1&query=<encoded address>`
 * 空/空白のみは null(QR を作らない)。
 */
export function buildMapsSearchUrl(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed === "") return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}
