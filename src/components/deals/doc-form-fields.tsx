"use client";

import type { FormDef, FormItem } from "@/lib/deals/documents/forms/types";
import { visibleEntries } from "@/lib/deals/documents/forms/values";
import { inputCls } from "./form-parts";

type OnChange = (key: string, v: string | string[] | null) => void;
const strOf = (v: unknown) => (typeof v === "string" ? v : "");
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * 項目の表から入力欄を描く(設計 第2段階 §3.3)。PDF も同じ表から作るので、画面と PDF の項目がずれない。
 * 1つ選ぶ=セレクト(先頭が空欄=PDF では □ を並べる)・いくつでも=チェックボックス・書き込み欄。
 */
export function DocFormFields({ form, values, onChange }: { form: FormDef; values: Record<string, unknown>; onChange: OnChange }) {
  const tabs = form.tabs;
  const tab = tabs ? strOf(values[tabs.key]) : "";
  return (
    <div className="space-y-3">
      {tabs && (
        <div role="tablist" aria-label={tabs.label} className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
          {tabs.choices.map((c) => (
            <button
              key={c.value} type="button" role="tab" aria-selected={tab === c.value ? "true" : "false"}
              onClick={() => onChange(tabs.key, c.value)}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-sm ${tab === c.value
                ? "border-gray-200 border-b-white bg-white font-semibold text-gray-900 dark:border-gray-800 dark:border-b-gray-900 dark:bg-gray-900 dark:text-gray-100"
                : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {visibleEntries(form, values).map((e, i) => (e.kind === "section"
        ? <h4 key={`s${i}`} className="pt-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{e.title}</h4>
        : <ItemFields key={e.key} item={e} values={values} onChange={onChange} />))}
    </div>
  );
}

function ItemFields({ item, values, onChange }: { item: FormItem; values: Record<string, unknown>; onChange: OnChange }) {
  const picked = listOf(values[item.key]);
  return (
    <div className={`space-y-1.5${item.sub ? " ml-4" : ""}`}>
      {item.label && (
        <p className={!item.choices?.length && !item.fields?.length
          ? "text-sm font-semibold text-gray-700 dark:text-gray-300"
          : "text-xs font-medium text-gray-600 dark:text-gray-400"}
        >
          {item.label}
        </p>
      )}
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
