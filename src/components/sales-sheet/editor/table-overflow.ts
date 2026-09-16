/**
 * table-overflow.ts
 *
 * Pure helper for the editor's "表の文字が入りきっていません" warning (仕様書 §4.8).
 * The caller measures each rendered `[data-sheet-table]` wrapper's
 * scrollHeight/clientHeight (overflow:hidden box) via ResizeObserver and passes the
 * measurements here; this function has no DOM dependency so it is trivially testable.
 */

/** 描画された表の外枠(overflow:hidden)と中身の高さから、入りきっていない表の id を返す(仕様書 §4.8)。 */
export function overflowingTableIds(
  boxes: Iterable<{ id: string; scrollHeight: number; clientHeight: number }>,
  tolerancePx = 1,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const box of boxes) {
    if (seen.has(box.id)) continue;
    if (box.scrollHeight > box.clientHeight + tolerancePx) {
      seen.add(box.id);
      out.push(box.id);
    }
  }
  return out;
}
