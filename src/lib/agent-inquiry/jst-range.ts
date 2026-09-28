const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JST の「今日 0:00」〜「明後日 0:00」(=今日と明日)を UTC の Date で返す。 */
export function todayTomorrowJst(now: Date) {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const startJstAsUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  const from = new Date(startJstAsUtc - JST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 2 * DAY_MS) };
}
