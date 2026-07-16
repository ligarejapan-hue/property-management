/**
 * 日時を "YYYY/MM/DD HH:MM:SS"(24時間・ゼロ埋め)で表示する共通関数。
 *
 * `new Date(...).toLocaleString("ja-JP")` は ja-JP ロケールで「時」が1桁になり
 * "2026/7/12 9:05:03" のように不揃いになる(分・秒は 2 桁)。表示用の日時整形は
 * この関数に統一して "2026/07/12 09:05:03" のように月日・時までゼロ埋めで揃える
 * (C-4 UI総点検)。整形はローカルタイムゾーン基準で、従来の toLocaleString と同じ挙動。
 *
 * null / undefined / 空文字 / 解釈不能な値は空文字を返す(呼び出し側の "—" などの
 * フォールバックはそのまま利用できる)。
 */
export function formatJaDateTime(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
