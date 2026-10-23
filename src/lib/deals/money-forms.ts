import { yen } from "./calc/format";

/** 金額の入力 → 円の整数。カンマ・円・空白は無視。空・小数・マイナス・数字以外は null。 */
export function parseYen(s: string): number | null {
  const t = s.replace(/[,，円\s]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export const yenText = (n: number | null) => (n === null ? "" : yen(n));

/** 1/100 % の整数 → 画面の % の文字(1000 → "10"・850 → "8.5")。 */
export const bpToPercentText = (bp: number) => String(bp / 100);

/** 画面の % の文字 → 1/100 % の整数。小数は2桁まで。 */
export function percentTextToBp(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
