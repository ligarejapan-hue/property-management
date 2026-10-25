/**
 * 書類を撮る — 撮った紙の並び(純関数)。変更が無ければ同じ参照を返す。
 */

/** 1回の撮影で1つの PDF にまとめる上限。 */
export const MAX_SCAN_PAGES = 30;

export function addPage<T>(pages: readonly T[], page: T): { ok: boolean; pages: readonly T[] } {
  if (pages.length >= MAX_SCAN_PAGES) return { ok: false, pages };
  return { ok: true, pages: [...pages, page] };
}

export function movePage<T extends { id: string }>(pages: readonly T[], id: string, delta: -1 | 1): readonly T[] {
  const from = pages.findIndex((p) => p.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= pages.length) return pages;
  const next = [...pages];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function removePage<T extends { id: string }>(pages: readonly T[], id: string): readonly T[] {
  return pages.some((p) => p.id === id) ? pages.filter((p) => p.id !== id) : pages;
}
