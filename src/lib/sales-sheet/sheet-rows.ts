import type { SheetField } from "./field-model";

export type SheetValue = string | string[] | undefined;
export type SheetValues = Record<string, SheetValue>;

/** 半角/全角いずれかの数字を含むか。単位を付けてよい値かの判定に使う。 */
const DIGIT_RE = /[0-9０-９]/;

/**
 * 数量ではない値（「なし」「無」「－」「相談」等）に単位を付けない。number ウィジェットでも
 * 自由入力なので「なし」と書かれることがあり、従来は unit をそのまま足して
 * 「私道負担 なし㎡」になっていた。build-document.ts の fmtValueWithUnit も同じ判定を使う。
 */
export function unitApplies(value: string): boolean {
  return DIGIT_RE.test(value);
}

/**
 * 数字だけの値に3桁区切りのカンマを入れる（"18800"→"18,800"、"1234.56"→"1,234.56"）。
 * 既にカンマが入っている／数字以外を含む（"1,200"・"応談"・"4LDK"）ものは触らない＝
 * 自由入力を壊さない。整数部のみ区切る。
 * 数量の欄（widget:"number"）にだけ使う。築年月のような文字の欄に使うと "2,018年" になる。
 */
export function groupDigits(s: string): string {
  // 日本語入力(IME)のまま全角で打たれた数字は \d に当たらず区切れない(@codex #432 P2)。
  // 数量として読める場合に限り半角へ揃えてから区切る。読めない値は元の文字列のまま返す。
  const half = s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".");
  const m = /^(\d+)(\.\d+)?$/.exec(half);
  if (!m) return s;
  return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[2] ?? "");
}

/**
 * value が既に unit の末尾一致で終わっている場合は付け直さない（build-document.ts の
 * fmtValueWithUnit と同じ厳密な末尾一致判定）。自由入力の number フィールド（価格/
 * 接道幅員 等）でユーザーが単位まで入力した場合の二重付与を防ぐ（例: "3,480万円" +
 * unit"万円" → "3,480万円"のまま／"3,480万円万円"にしない）。
 */
export function formatValue(field: SheetField, v: SheetValue): string {
  if (field.widget === "multiselect") {
    return Array.isArray(v) ? v.filter(Boolean).join(" / ") : "";
  }
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  // 桁区切りは数量の欄だけ（発注者指示 2026-09-16: 価格以外の数量にも入れる）。
  const num = field.widget === "number" ? groupDigits : (x: string) => x;
  if (!field.unit) return num(s);
  // 単位まで入力されている場合も、数字部分には区切りを入れる（単位は付け直さない）。
  if (s.endsWith(field.unit)) return `${num(s.slice(0, -field.unit.length).trim())}${field.unit}`;
  if (!unitApplies(s)) return s;
  return `${num(s)}${field.unit}`;
}

export function buildSheetRows(
  fields: readonly SheetField[],
  values: SheetValues,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const f of fields) {
    if (f.controlOnly) continue;
    if (f.showWhen) {
      const ctrl = values[f.showWhen.field];
      if ((typeof ctrl === "string" ? ctrl : "") !== f.showWhen.equals) continue;
    }
    rows.push({ label: f.label, value: formatValue(f, values[f.key]) });
  }
  return rows;
}
