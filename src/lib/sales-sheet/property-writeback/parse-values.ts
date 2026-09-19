/**
 * 図面の自由入力を、物件へ保存できる形へ読み取る純関数群(仕様書 §8)。
 * 読み取れない値は null を返し、呼び出し側はその欄を保存しない(図面の表示は入力のまま)。
 */

/** 全角数字・全角ピリオド・全角カンマを半角へ。 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .replace(/，/g, ",");
}

/** 末尾に付きうる単位(長いものから削る)。 */
const UNIT_SUFFIXES = ["万円/年", "円/月", "万円", "㎡", "%", "％", "階", "戸", "円"];

export function parseNumeric(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  let s = toHalfWidth(raw).trim();
  if (!s) return null;
  for (const u of UNIT_SUFFIXES) {
    if (s.endsWith(u)) {
      s = s.slice(0, -u.length).trim();
      break;
    }
  }
  // カンマの位置が正しい場合だけ数値として通す
  // 正しいパターン: "1,234" または "1,234.56" または "1234" または "1234.56"
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) && !/^\d+(\.\d+)?$/.test(s)) {
    return null;
  }
  const num = Number(s.replace(/,/g, ""));
  return Number.isFinite(num) ? num : null;
}

/** 元号 → 元年の前年(和暦N年 = base + N)。 */
const ERA_BASE: Record<string, number> = { 明治: 1867, 大正: 1911, 昭和: 1925, 平成: 1988, 令和: 2018 };

export function parseBuiltYearMonth(
  raw: string | undefined,
): { year: number; month: number | null } | null {
  if (typeof raw !== "string") return null;
  const s = toHalfWidth(raw).trim();
  if (!s) return null;

  const era = /^(明治|大正|昭和|平成|令和)\s*(\d{1,2})年\s*(?:(\d{1,2})月)?/.exec(s);
  if (era) {
    const year = ERA_BASE[era[1]] + Number(era[2]);
    return { year, month: monthOrNull(era[3]) };
  }

  const ad = /^(\d{4})\s*(?:年|\/|-)?\s*(?:(\d{1,2})\s*(?:月|\/|-)?)?/.exec(s);
  if (ad && /^\d{4}/.test(s)) {
    return { year: Number(ad[1]), month: monthOrNull(ad[2]) };
  }
  return null;
}

function monthOrNull(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = Number(v);
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
}

export function pickOption(raw: string | undefined, options: readonly string[]): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return options.includes(s) ? s : null;
}
