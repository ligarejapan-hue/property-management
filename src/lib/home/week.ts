/**
 * ホームの「今週の予定」(2026-11-10 案4)の共通部品。日付は日本時間の YYYY-MM-DD で扱う。
 * DB・権限には触らない(純粋な関数だけ)=画面と API の両方から使う。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export type WeekItemKind = "next_action" | "viewing" | "contract" | "settlement";

/** API が返す予定1件。所有者名・連絡先・緯度経度・自由記述は入れない。 */
export interface WeekItem {
  key: string;
  kind: WeekItemKind;
  /** 日本時間の YYYY-MM-DD */
  date: string;
  /** 日本時間の "HH:MM"。null=終日(時刻なし) */
  time: string | null;
  /** 物件の所在・建物名や取引の名前 */
  title: string;
  /** 次回対応の種類・内見の種類など(短い語) */
  sub: string | null;
  /** 全員表示のときだけ、誰の予定か(表示名) */
  who: string | null;
  href: string;
  /** 受付の窓で開く(名前付きの窓) */
  desk: boolean;
  overdue: boolean;
}

export interface WeekResponse {
  /** 週の初め(月曜)の YYYY-MM-DD */
  weekStart: string;
  scope: "mine" | "all";
  /** 管理者だけ true(「全員」に切り替えられる) */
  canSeeAll: boolean;
  items: WeekItem[];
  /** 種類ごとに上限で切ったか */
  hasMore: boolean;
}

export const WEEK_KIND_LABEL: Record<WeekItemKind, string> = {
  next_action: "次回対応",
  viewing: "内見",
  contract: "契約",
  settlement: "決済",
};

export function isYmd(v: string): boolean {
  if (!YMD_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDaysYmd(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** その日を含む週の月曜。 */
export function weekStartOf(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00.000Z`).getUTCDay(); // 0=日
  return addDaysYmd(ymd, dow === 0 ? -6 : 1 - dow);
}

/** 日本時間の今日。 */
export function jstTodayYmd(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 週(月曜 0:00〜翌月曜 0:00・日本時間)の範囲を UTC の Date で。 */
export function weekRangeUtc(weekStart: string): { from: Date; to: Date } {
  const from = new Date(Date.parse(`${weekStart}T00:00:00.000+09:00`));
  return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

/** 時刻を持つ値(timestamp)を日本時間の日付と "HH:MM" に。 */
export function jstDateTime(d: Date): { date: string; time: string } {
  const iso = new Date(d.getTime() + JST_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

export function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** グリッドの時刻の行(8時〜19時)。その外の予定は端の行にまとめる。 */
export const FIRST_HOUR = 8;
export const LAST_HOUR = 19;

export function hourRow(time: string): number {
  const h = Number(time.slice(0, 2));
  return Math.min(LAST_HOUR, Math.max(FIRST_HOUR, h));
}

export function hourRowLabel(h: number): string {
  if (h === FIRST_HOUR) return `〜${h}時`;
  if (h === LAST_HOUR) return `${h}時〜`;
  return `${h}時`;
}

const sortItems = (a: WeekItem, b: WeekItem) =>
  (a.time ?? "").localeCompare(b.time ?? "") || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key);

export interface WeekDay {
  date: string;
  label: string;
  isToday: boolean;
  allDay: WeekItem[];
  /** 時刻ありの予定(時刻順) */
  timed: WeekItem[];
}

/**
 * 週の日の並び。月〜金は必ず出し、土日は予定がある日だけ出す。
 * 範囲の外の日付の予定は捨てる(API の取り違えで別の週の予定が混ざらないように)。
 */
export function buildWeekDays(weekStart: string, items: WeekItem[], today: string): WeekDay[] {
  const days: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysYmd(weekStart, i);
    const mine = items.filter((it) => it.date === date).sort(sortItems);
    if (i >= 5 && mine.length === 0) continue;
    days.push({
      date, label: dayLabel(date), isToday: date === today,
      allDay: mine.filter((it) => it.time === null),
      timed: mine.filter((it) => it.time !== null),
    });
  }
  return days;
}
