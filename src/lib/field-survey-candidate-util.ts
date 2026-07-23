/**
 * 完成待ち候補 (物件化候補ピン) 一覧の表示ロジック。
 *
 * 放置の可視化が目的: 一覧が「日時だけ」だと何日放置されたか読み取れず、
 * 取りこぼし防止という画面の目的を果たせない。経過日数の表示と
 * しきい値超えの強調 (stale) を純関数で提供する。
 */

/** 候補一覧 API の取得上限 (route と共有)。超過時は古い候補が表示されない。 */
export const CANDIDATE_LIST_LIMIT = 200;

/** この日数以上放置された候補は強調表示する。 */
export const CANDIDATE_STALE_DAYS = 7;

/** JST の暦日番号 (エポックからの日数)。日付の跨ぎ判定に使う。 */
function jstDayNumber(epochMs: number): number {
  return Math.floor((epochMs + 9 * 3_600_000) / 86_400_000);
}

/**
 * 次の JST 0:00 までのミリ秒。画面を開いたまま日付を跨いだ時に
 * 「今日/昨日/N日前」の表示を更新するタイマーの遅延に使う。
 * 最低 1 秒 (0 や負値での即時連発を防ぐ)。
 */
export function msUntilNextJstMidnight(now: Date): number {
  const t = now.getTime();
  if (!Number.isFinite(t)) return 86_400_000;
  const nextMidnight = (jstDayNumber(t) + 1) * 86_400_000 - 9 * 3_600_000;
  return Math.max(1_000, nextMidnight - t);
}

/**
 * 作成日時から経過日数の表示を作る。**JST の暦日**基準
 * (昨夜 23 時に立てた候補は今日の昼に見れば「昨日」)。
 * - 0日=「今日」/ 1日=「昨日」/ それ以上=「N日前」
 * - 未来日時 (端末時計ズレ) は 0 日に丸める
 * - 不正値は空 label (例外を出さない)
 */
export function describeCandidateAge(
  createdAt: string | Date,
  now: Date,
): { label: string; days: number; stale: boolean } {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const t = d.getTime();
  if (!Number.isFinite(t) || !Number.isFinite(now.getTime())) {
    return { label: "", days: 0, stale: false };
  }
  const days = Math.max(0, jstDayNumber(now.getTime()) - jstDayNumber(t));
  const label = days === 0 ? "今日" : days === 1 ? "昨日" : `${days}日前`;
  return { label, days, stale: days >= CANDIDATE_STALE_DAYS };
}
