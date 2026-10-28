/**
 * 物件の画面を「タブを指定して」開く(2026-10-28)。
 * 例: ドライブ連携の紐づけ一覧から、その物件の「添付ファイル」タブへ。
 * ⚠知らない値は黙って「基本情報」にする(URL を手で書き換えても画面は壊れない)。
 */

export function propertyDetailHref(propertyId: string, tab?: string): string {
  const base = `/properties/${encodeURIComponent(propertyId)}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
}

export function initialPropertyTab<K extends string>(
  raw: string | string[] | undefined,
  keys: readonly K[],
): K | "basic" {
  if (typeof raw !== "string") return "basic";
  return (keys as readonly string[]).includes(raw) ? (raw as K) : "basic";
}
