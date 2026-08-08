// 実在するカレンダー日付の検証(@codex #364 R1)。
// 正規表現(YYYY-MM-DD)だけでは 2026-02-31 や 2026-99-99 が通り、そのまま new Date() に
// 渡すと別の日へ正規化される/Invalid Date が Prisma まで届く。UTC で往復一致を検査する。

export function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}
