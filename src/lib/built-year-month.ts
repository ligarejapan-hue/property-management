/**
 * 築年・築月の表示文字列を作る共通関数。
 *
 * [@codex P2] 築年と築月は別々の列で、どちらか片方だけでも保存できる（API も独立して
 * 受け付ける）。表示側が「築年があるときだけ出す」と書くと、**築月だけ入れた値が
 * 保存されているのに画面から消える**（編集フォームには出るので、消えたように見えて
 * 消えていない、という一番分かりにくい状態になる）。片方だけでも出す。
 */
export function formatBuiltYearMonth(
  builtYear: number | null | undefined,
  builtMonth: number | null | undefined,
): string {
  if (builtYear != null) {
    return builtMonth != null ? `${builtYear}年${builtMonth}月` : `${builtYear}年`;
  }
  return builtMonth != null ? `${builtMonth}月` : "";
}
