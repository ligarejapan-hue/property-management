/**
 * 物件の基本情報の「取得済」の右に出す取得日(2026-11-06 発注者)。
 *
 * 取得日 = その物件の謄本の添付(削除していないもの)のいちばん新しいアップロード日時と、
 * システムの謄本の取得が成功した記録のいちばん新しい日時のうち、新しいほう(日本時間の日付)。
 * どちらも無い(手で取得済にしただけ)なら出さない。2筆以上の物件も物件全体で1つ。
 * ⚠列は持たない=いまある記録から求める(画面を開くたびに、索引のある問い合わせ2つ)。
 */

/** いちばん新しい日時。どれも無ければ null。 */
export function latestRegistryObtainedAt(dates: ReadonlyArray<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const d of dates) {
    if (!d || Number.isNaN(d.getTime())) continue;
    if (latest === null || d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}

const JST_YMD = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 「取得日 YYYY/MM/DD」(日本時間)。取得済でない・日時が無い・読めないときは null。 */
export function registryObtainedDateLabel(
  registryStatus: string,
  obtainedAt: string | null | undefined,
): string | null {
  if (registryStatus !== "obtained" || !obtainedAt) return null;
  const d = new Date(obtainedAt);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(JST_YMD.formatToParts(d).map((p) => [p.type, p.value]));
  return `取得日 ${parts.year}/${parts.month}/${parts.day}`;
}
