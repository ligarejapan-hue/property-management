import type { SheetField } from "./field-model";

export type SheetValue = string | string[] | undefined;
export type SheetValues = Record<string, SheetValue>;

function formatValue(field: SheetField, v: SheetValue): string {
  if (field.widget === "multiselect") {
    return Array.isArray(v) ? v.filter(Boolean).join(" / ") : "";
  }
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  return field.unit ? `${s}${field.unit}` : s;
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
