import type { FormDef, FormItem, FormValues } from "./types";

/** 項目だけを並び順に。 */
export const formItems = (f: FormDef): FormItem[] => f.entries.filter((e): e is FormItem => e.kind === "item");

/** すべて空欄(手書き用)の値。 */
export function emptyFormValues(f: FormDef): FormValues {
  const v: FormValues = {};
  for (const it of formItems(f)) {
    if (it.choices?.length) v[it.key] = it.multiple ? [] : null;
    for (const fl of it.fields ?? []) v[fl.key] = null;
  }
  return v;
}
