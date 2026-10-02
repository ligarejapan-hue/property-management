/**
 * 新着(査定申込・謄本の一括取得の完了)をカーソルで取るための条件と比べ方(設計書 §5.1)。**純関数だけ**。
 *
 * ⚠既存の `inquiryCursorWhere`(申込一覧を古い方へめくる)とは向きが逆。新着は
 *   「カーソルより後」= `(t, id) > (ct, ci)` を**昇順**で取る。
 * ⚠時刻を先に決めてから確定が遅れる行(申込の submittedAt・ジョブの completedAt)を拾うため、
 *   カーソルの5分前から読み直す。読み直しはカーソルを動かさない。
 */
import type { EventCursor } from "./opaque";

export const REREAD_WINDOW_MS = 5 * 60 * 1000;
/** ①カーソルより後を1回に取る件数。超えた分は次の問い合わせで続きを取る。 */
export const AFTER_CURSOR_LIMIT = 100;
/** ②読み直しを中でめくる件数(上限で切らない)。 */
export const REREAD_PAGE = 100;

/** (t, id) の辞書順の比較。ID は小文字の UUID 文字列(Postgres の uuid の並びと同じ)。 */
export function compareCursor(a: EventCursor, b: EventCursor): number {
  const d = a.t.getTime() - b.t.getTime();
  if (d !== 0) return d < 0 ? -1 : 1;
  const ai = a.i.toLowerCase();
  const bi = b.i.toLowerCase();
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** 次のカーソル = 受け取ったカーソルと①の最後の大きい方(決して戻さない)。 */
export function advanceCursor(current: EventCursor, afterRows: EventCursor[]): EventCursor {
  let best = current;
  for (const r of afterRows) if (compareCursor(r, best) > 0) best = r;
  return best;
}

type Field = "submittedAt" | "completedAt";

/** ① カーソルより後: `t > ct OR (t = ct AND id > ci)`。 */
export function afterCursorWhere(field: Field, c: EventCursor) {
  return { OR: [{ [field]: { gt: c.t } }, { [field]: c.t, id: { gt: c.i } }] };
}

/** ② 読み直し: `t >= ct − 5分` かつ `(t, id) <= (ct, ci)`。 */
export function rereadWhere(field: Field, c: EventCursor) {
  return {
    [field]: { gte: new Date(c.t.getTime() - REREAD_WINDOW_MS) },
    OR: [{ [field]: { lt: c.t } }, { [field]: c.t, id: { lte: c.i } }],
  };
}

/** ② の続き(昇順で前のページの最後より後)。 */
export function pageAfterWhere(field: Field, last: EventCursor | null) {
  return last ? afterCursorWhere(field, last) : {};
}
