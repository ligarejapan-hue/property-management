"use client";

import type { FormDef, FormItem } from "@/lib/deals/documents/forms/types";
import { inputCls } from "./form-parts";

type OnChange = (key: string, v: string | string[] | null) => void;
const strOf = (v: unknown) => (typeof v === "string" ? v : "");
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 項目の表から入力欄を描く(設計 第2段階 §3.3)。PDF も同じ表から作るので、画面と PDF の項目がずれない。
 * 1つ選ぶ=セレクト(先頭が空欄=PDF では □ を並べる)・いくつでも=チェックボックス・書き込み欄。
 */
export function DocFormFields({ form, values, onChange }: { form: FormDef; values: Record<string, unknown>; onChange: OnChange }) {
  return (
    <div className="space-y-3">
      {form.entries.map((e, i) => (e.kind === "section"
        ? <h4 key={`s${i}`} className="pt-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{e.title}</h4>
        : <ItemFields key={e.key} item={e} values={values} onChange={onChange} />))}
    </div>
  );
}

function ItemFields({ item, values, onChange }: { item: FormItem; values: Record<string, unknown>; onChange: OnChange }) {
  const picked = listOf(values[item.key]);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">{item.label}</p>
      {item.choices?.length ? (item.multiple ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {item.choices.map((c) => (
            <label key={c.value} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(c.value)}
                onChange={(ev) => onChange(item.key, ev.target.checked ? [...picked, c.value] : picked.filter((x) => x !== c.value))}
              />
              {c.label}
            </label>
          ))}
        </div>
      ) : (
        <select aria-label={item.label} value={strOf(values[item.key])} onChange={(ev) => onChange(item.key, ev.target.value || null)} className={inputCls}>
          <option value="">(空欄=□ で出す)</option>
          {item.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )) : null}
      {(item.fields ?? []).map((f) => (f.lines && f.lines > 1 ? (
        <textarea
          key={f.key} aria-label={`${item.label} ${f.label}`} placeholder={f.label} value={strOf(values[f.key])}
          onChange={(ev) => onChange(f.key, ev.target.value || null)} maxLength={f.max} rows={f.lines} className={inputCls}
        />
      ) : (
        <input
          key={f.key} type="text" aria-label={`${item.label} ${f.label}`} placeholder={f.label} value={strOf(values[f.key])}
          onChange={(ev) => onChange(f.key, ev.target.value || null)} maxLength={f.max} className={inputCls}
        />
      )))}
    </div>
  );
}
