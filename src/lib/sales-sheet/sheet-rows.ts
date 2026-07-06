import type { SheetField } from "./field-model";

export type SheetValue = string | string[] | undefined;
export type SheetValues = Record<string, SheetValue>;

/**
 * value が既に unit の末尾一致で終わっている場合は付け直さない（build-document.ts の
 * fmtValueWithUnit と同じ厳密な末尾一致判定）。自由入力の number フィールド（価格/
 * 接道幅員 等）でユーザーが単位まで入力した場合の二重付与を防ぐ（例: "3,480万円" +
 * unit"万円" → "3,480万円"のまま／"3,480万円万円"にしない）。
 */
function formatValue(field: SheetField, v: SheetValue): string {
  if (field.widget === "multiselect") {
    return Array.isArray(v) ? v.filter(Boolean).join(" / ") : "";
  }
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  if (!field.unit) return s;
  if (s.endsWith(field.unit)) return s;
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
