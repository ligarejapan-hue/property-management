import type { FormDef, FormEntry, FormItem, FormValues } from "./types";

/** 項目だけを並び順に(タブで隠れる項目も含む)。 */
export const formItems = (f: FormDef): FormItem[] => f.entries.filter((e): e is FormItem => e.kind === "item");

/** 選んでいるタブで出す区切りと項目(タブが無ければ全部)。 */
export function visibleEntries(f: FormDef, v: Record<string, unknown>): FormEntry[] {
  const tab = f.tabs ? v[f.tabs.key] : undefined;
  return f.entries.filter((e) => !e.only || (typeof tab === "string" && e.only.includes(tab)));
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

/** 「すべて空欄に戻す」: 全部空欄にするが、選んでいるタブと PDF に出さない設定(説明のページなど)はそのまま。 */
export function clearFormValues(f: FormDef, v: Record<string, unknown>): FormValues {
  const out = emptyFormValues(f);
  for (const it of formItems(f)) {
    const x = v[it.key];
    if (it.noPrint && (typeof x === "string" || Array.isArray(x))) out[it.key] = x as string | string[];
  }
  const tab = f.tabs ? v[f.tabs.key] : undefined;
  if (f.tabs && typeof tab === "string" && f.tabs.choices.some((c) => c.value === tab)) out[f.tabs.key] = tab;
  return out;
}

/**
 * 古い控え・写し(書式が変わる前の入力)を今の書式に合わせる(2026-10-30)。
 * 合う項目はそのまま・合わない項目(消えた選択肢・長すぎる書き込み・形の違う値)は base の値に戻し、知らない鍵は捨てる。
 * dropped = 戻した・捨てたものがあったか(小窓で知らせる)。結果は formValuesSchema を必ず通る。
 */
export function fitFormValues(f: FormDef, raw: unknown, base: FormValues): { values: FormValues; dropped: boolean } {
  const v: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let dropped = !(raw && typeof raw === "object" && !Array.isArray(raw));
  const out: FormValues = { ...base };
  const known = new Set<string>();
  const take = (key: string, ok: (x: unknown) => boolean, fix: (x: unknown) => FormValues[string] = (x) => x as FormValues[string]) => {
    known.add(key);
    if (!(key in v)) return;
    if (ok(v[key])) out[key] = fix(v[key]);
    else dropped = true;
  };
  if (f.tabs) {
    const tabs = f.tabs.choices.map((c) => c.value);
    take(f.tabs.key, (x) => typeof x === "string" && tabs.includes(x));
  }
  for (const it of formItems(f)) {
    const values = (it.choices ?? []).map((c) => c.value);
    if (values.length && it.multiple) {
      take(it.key, (x) => Array.isArray(x), (x) => {
        const xs = (x as unknown[]).filter((y): y is string => typeof y === "string" && values.includes(y));
        if (xs.length !== (x as unknown[]).length) dropped = true;
        return [...new Set(xs)];
      });
    } else if (values.length) {
      take(it.key, (x) => x === null || (typeof x === "string" && values.includes(x)));
    }
    for (const fl of it.fields ?? []) take(fl.key, (x) => x === null || (typeof x === "string" && x.trim().length <= fl.max));
  }
  if (Object.keys(v).some((k) => !known.has(k))) dropped = true;
  return { values: out, dropped };
}
