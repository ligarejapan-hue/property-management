/**
 * 添付先の選択を、いま表示している物件の中に限る(純関数)。
 * ⚠検索をやり直して前に選んだ物件が表示から消えたら、選択を外す(@codex PR#500 8巡目)。
 *   残すと、どれも選ばれていない見た目のまま「この物件に添付」で前の物件へ付いてしまう。
 */
export function keepSelectionIfShown(
  current: string | null,
  shownPropertyIds: readonly string[],
): string | null {
  return current !== null && shownPropertyIds.includes(current) ? current : null;
}
