/**
 * 完成待ち候補一覧の「続きの位置」(キーセット方式のページ送り)。
 *
 * ⚠**なぜ「◯ページ目」方式にしないか**
 *   この一覧は上から順に片付ける作業リストで、読んでいる最中に行が消える
 *   (物件化 / 却下)。件数で位置を数える方式 (skip/offset) だと、消えた分だけ
 *   後続が繰り上がり、**次のページで行が飛ばされる**。取りこぼしを防ぐ画面で
 *   取りこぼしを作ってしまう。
 *   「最後に見た行そのもの」を基準にすれば、間の行が消えても飛ばない。
 *
 * ⚠基準は `(createdAt, id)` の2つ。`createdAt` だけでは**同時刻の行**
 *   (一括投入・秒未満が同値) で並びが決まらず、取りこぼし/重複が出る。
 *   route の `orderBy: [{createdAt}, {id}]` と**同じ2段**にすること。
 *
 * 判定は DB に投げる前に純関数で決め、総当たりで検証する
 * (`__tests__/field-survey-candidate-cursor.test.ts`)。
 */

export type CandidateOrder = "newest" | "oldest";

export interface CandidateCursor {
  createdAt: Date;
  id: string;
}

/** カーソル文字列の最大長。壊れた/巨大な入力を decode 前に切る。 */
const MAX_CURSOR_LENGTH = 200;

/** UUID (ピンID) の形。decode 時に形を確かめてから DB へ渡す。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 「続きの位置」を1本の文字列にする。
 * ⚠中身は `createdAt` と**ピンID のみ**。座標・メモ・担当者は入れない
 *   (一覧 API が返さない情報をカーソル経由で漏らさない)。
 */
export function encodeCandidateCursor(c: CandidateCursor): string {
  const t = c.createdAt.getTime();
  if (!Number.isFinite(t)) {
    throw new Error("createdAt が不正です");
  }
  return `${c.createdAt.toISOString()}_${c.id}`;
}

/**
 * カーソル文字列を読む。**読めなければ null**(例外を投げない)。
 * 呼び出し側は null を「不正な指定」として 400 で返す。
 * ⚠壊れたカーソルを黙って「先頭から」に倒すと、利用者は同じページを
 *   延々と読み続けることになる。必ず失敗として伝える。
 */
export function decodeCandidateCursor(
  raw: string | null | undefined,
): CandidateCursor | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_CURSOR_LENGTH) return null;

  // ISO 日時にも `_` は現れないので、最後の `_` で割る必要はない。
  const sep = s.indexOf("_");
  if (sep <= 0 || sep === s.length - 1) return null;

  const isoPart = s.slice(0, sep);
  const idPart = s.slice(sep + 1);
  if (!UUID_RE.test(idPart)) return null;

  const ms = Date.parse(isoPart);
  if (!Number.isFinite(ms)) return null;
  const createdAt = new Date(ms);
  // `Date.parse` は "2026-13-45" のような値も通す実装があるため、
  // 往復させて同じ文字列に戻ることを確かめる。
  if (createdAt.toISOString() !== isoPart) return null;

  return { createdAt, id: idPart };
}

/**
 * その行がカーソルより「後ろ」か (= 次のページに入るか) の判定。
 * **これが唯一の正**。Prisma の where はこれと一致していなければならない
 * (テストで where を評価して突き合わせる)。
 */
export function isAfterCandidateCursor(
  row: { createdAt: Date; id: string },
  cursor: CandidateCursor,
  order: CandidateOrder,
): boolean {
  const rt = row.createdAt.getTime();
  const ct = cursor.createdAt.getTime();
  if (rt !== ct) return order === "newest" ? rt < ct : rt > ct;
  // 同時刻は id で決める (route の orderBy 2段目と同じ向き)。
  return order === "newest" ? row.id < cursor.id : row.id > cursor.id;
}

/**
 * Prisma の where 断片。カーソル未指定なら `undefined`(絞り込みなし)。
 * ⚠`isAfterCandidateCursor` と**同じ意味**でなければならない。
 */
export function candidateKeysetWhere(
  cursor: CandidateCursor | null,
  order: CandidateOrder,
):
  | {
      OR: [
        { createdAt: { lt: Date } | { gt: Date } },
        { AND: [{ createdAt: Date }, { id: { lt: string } | { gt: string } }] },
      ];
    }
  | undefined {
  if (!cursor) return undefined;
  const newest = order === "newest";
  return {
    OR: [
      { createdAt: newest ? { lt: cursor.createdAt } : { gt: cursor.createdAt } },
      {
        AND: [
          { createdAt: cursor.createdAt },
          { id: newest ? { lt: cursor.id } : { gt: cursor.id } },
        ],
      },
    ],
  };
}
