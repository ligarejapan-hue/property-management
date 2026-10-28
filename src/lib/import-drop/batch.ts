/**
 * 「ファイルを入れる」の表(まとめて入れたファイルの一覧)を、取り込みの画面へ進んで戻っても残す入れ物
 * (画面側だけ・2026-10-28 @codex #607 P2)。
 *
 * まとめて入れて1件目の取り込みへ進むと、画面が切り替わって表が消え、残りのファイル(受付帳と一緒に
 * 入れた所有者の一覧など)をもう一度入れ直すことになる。そこで表を画面の外に置き、戻ったら続きを出す。
 * ⚠File は控え(sessionStorage)に入らないので、画面の中の入れ物に置く。再読み込みやタブを閉じると消える。
 */
let saved: readonly unknown[] = [];

/** 前に出していた表(無ければ空)。 */
export function loadDropBatch<T>(): T[] {
  return [...(saved as readonly T[])];
}

/** 今の表を置く。 */
export function saveDropBatch<T>(rows: readonly T[]): void {
  saved = [...rows];
}

/** 表を捨てる。 */
export function clearDropBatch(): void {
  saved = [];
}
