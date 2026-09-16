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
  if (!field.unit) return s;
  if (s.endsWith(field.unit)) return s;
  if (!unitApplies(s)) return s;
  return `${s}${field.unit}`;
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
