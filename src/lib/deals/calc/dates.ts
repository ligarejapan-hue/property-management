/** 計算用の日付は "YYYY-MM-DD" の文字列。時差を持ち込まないよう UTC の暦で数える。 */
const DAY = 24 * 60 * 60 * 1000;

export function parseYmd(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

export function ymd(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

const utc = (s: string) => {
  const { y, m, d } = parseYmd(s);
  return Date.UTC(y, m - 1, d);
};

export function addDays(s: string, n: number): string {
  return new Date(utc(s) + n * DAY).toISOString().slice(0, 10);
}

/** from から to まで(両端を含む)の日数。 */
export function daysInclusive(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY) + 1;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
