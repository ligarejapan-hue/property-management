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

/**
 * 測った「入りきっていない表」のうち、**今の図面に実在する表**だけを返す。
 * 表を全部消すと、測る処理(ResizeObserver)は観測する表が無いため何もせずに抜け、
 * 最後に測った記録が残る=警告が消えなかった(実機確認 132 の既知の残り)。
 * 状態を effect の中で直接消す代わりに、表示するときにここで絞り込む。
 */
export function liveOverflowTableIds(
  overflowIds: readonly string[],
  document: { elements: readonly { id: string; type: string }[] },
): string[] {
  const tables = new Set(document.elements.filter((e) => e.type === "table").map((e) => e.id));
  return overflowIds.filter((id) => tables.has(id));
}
