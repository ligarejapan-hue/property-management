import { isSystemExtraOnly } from "./diff";

/**
 * 判断待ちの「違う」から、自動で外すのを試す物件を選ぶ(純関数・@codex #734 P2)。
 * ⚠当たらない行(謄本が多い・ほかの種類が混ざる)を**先に除いてから**上限で切る。切ってから除くと、
 *   古い当たらない行が先頭に居座り、その先の当たる物件にいつまでも届かない(当たらない行は印も時刻も
 *   変わらないので、毎回同じ行が選ばれる)。
 */
export function pickAutoRemoveCandidates(
  rows: ReadonlyArray<{ property_id: string; diff_kind: string | null }>,
  limit: number,
): string[] {
  return rows
    .filter((r) => isSystemExtraOnly(r.diff_kind))
    .slice(0, Math.max(0, limit))
    .map((r) => r.property_id);
}
