/**
 * 「1行に1つ」の欄(お持ちいただくもの など)の行の比べ方(2026-11-15 発注者)。
 * 発行の小窓は前回の入力から始まるので、あとから当事者が変わって初めの値に増えた行(委任状・実印 など)に気づけない。
 * 勝手には足さず、足りない行を知らせて「足す」で入れるための純関数(画面・テストで共有)。
 */

/** 前後の空白を落とし、空行を捨てた行。 */
const linesOf = (s: string | null | undefined): string[] => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

/** fresh(今の初めの値)にあって current(欄の今の入力)に無い行。fresh の順・重なりは1つ。行の中身はそのまま比べる。 */
export function missingLines(current: string | null | undefined, fresh: string | null | undefined): string[] {
  const have = new Set(linesOf(current));
  const out: string[] = [];
  for (const l of linesOf(fresh)) {
    if (!have.has(l)) { have.add(l); out.push(l); }
  }
  return out;
}

/** 欄の末尾に行を足す(1行に1つ・すでにある行は足さない)。今の入力は書き換えず、末尾の空行だけ詰める。 */
export function appendLines(current: string | null | undefined, add: readonly string[]): string {
  const base = (current ?? "").replace(/\s+$/, "");
  return [...(base ? [base] : []), ...missingLines(base, add.join("\n"))].join("\n");
}
