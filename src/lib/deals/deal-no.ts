/** 取引番号 = 日本時間の年 + "-" + 4桁の通し番号(例 2026-0001)。 */
export function jstYear(now: Date): number {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();
}

export function nextDealNo(year: number, latest: string | null): string {
  const prefix = `${year}-`;
  const seq = latest && latest.startsWith(prefix) ? Number(latest.slice(prefix.length)) + 1 : 1;
  // 4桁を超えると文字列の並びで最新が取れなくなる(9999 の次が 10000 で前に並ぶ)ため止める。
  if (!Number.isInteger(seq) || seq > 9999) throw new Error("取引番号がこの年の上限(9999)に達しました");
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
