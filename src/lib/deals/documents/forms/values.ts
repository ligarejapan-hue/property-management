import type { FormDef, FormEntry, FormItem, FormValues } from "./types";

/** 項目だけを並び順に(タブで隠れる項目も含む)。 */
export const formItems = (f: FormDef): FormItem[] => f.entries.filter((e): e is FormItem => e.kind === "item");

/** 選んでいるタブで出す区切りと項目(タブが無ければ全部)。 */
export function visibleEntries(f: FormDef, v: Record<string, unknown>): FormEntry[] {
  const tab = f.tabs ? v[f.tabs.key] : undefined;
  return f.entries.filter((e) => e.kind === "section" || !e.only || (typeof tab === "string" && e.only.includes(tab)));
}

/** すべて空欄(手書き用)の値。タブは最初の選択肢。 */
export function emptyFormValues(f: FormDef): FormValues {
  const v: FormValues = {};
  if (f.tabs) v[f.tabs.key] = f.tabs.choices[0].value;
  for (const it of formItems(f)) {
    if (it.choices?.length) v[it.key] = it.multiple ? [] : null;
    for (const fl of it.fields ?? []) v[fl.key] = null;
  }
  return v;
}

/** 「すべて空欄に戻す」: 全部空欄にするが、選んでいるタブはそのまま。 */
export function clearFormValues(f: FormDef, v: Record<string, unknown>): FormValues {
  const out = emptyFormValues(f);
  const tab = f.tabs ? v[f.tabs.key] : undefined;
  if (f.tabs && typeof tab === "string" && f.tabs.choices.some((c) => c.value === tab)) out[f.tabs.key] = tab;
  return out;
}
