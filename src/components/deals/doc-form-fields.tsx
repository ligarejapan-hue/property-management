"use client";

import type { FormDef, FormEntry, FormField, FormItem } from "@/lib/deals/documents/forms/types";
import { visibleEntries } from "@/lib/deals/documents/forms/values";
import { inputCls } from "./form-parts";

type OnChange = (key: string, v: string | string[] | null) => void;
const strOf = (v: unknown) => (typeof v === "string" ? v : "");
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 空欄の選択肢の説明(PDF での実際の出方に合わせる・2026-10-30)。 */
const BLANK_OPTION = { box: "(空欄=□ で出す)", plain: "(空欄=手書き用に空けて出す)" } as const;

/** 書き込み欄の見本と読み上げの名前。下線の後ろに字を出す欄は書式の形(「計＿台」「＿年」)を見本にする(2026-10-30)。 */
function fieldTexts(itemName: string, f: FormField): { placeholder: string; ariaLabel: string } {
  return {
    placeholder: f.after ? `${f.pre ?? ""}＿${f.label}` : f.label,
    ariaLabel: `${itemName} ${[f.pre, f.label].filter(Boolean).join(" ")}`.trim(),
  };
}

/**
 * 下の行の読み上げに付ける、上の番号の行(部門)の名前。Excel の行の名前と同じ付け方(2026-10-30)。
 * 名前の無い下の行(告知書の「箇所・状況：」・付帯設備表の「空欄の行」など)も、どの項目の欄か分かるように。
 */
function headsOf(entries: FormEntry[]): string[] {
  const out: string[] = [];
  let head = "";
  for (const e of entries) {
    if (e.kind === "item" && !e.sub) head = e.name ?? e.label;
    out.push(e.kind === "item" && e.sub ? head : "");
  }
  return out;
}

/**
 * 項目の表から入力欄を描く(設計 第2段階 §3.3)。PDF も同じ表から作るので、画面と PDF の項目がずれない。
 * 1つ選ぶ=セレクト(先頭が空欄=PDF では □ を並べる。blankStyle が plain の書類は丸も □ も付けずに空ける)・いくつでも=チェックボックス・書き込み欄。
 */
export function DocFormFields({ form, values, onChange }: { form: FormDef; values: Record<string, unknown>; onChange: OnChange }) {
  const tabs = form.tabs;
  const tab = tabs ? strOf(values[tabs.key]) : "";
  const entries = visibleEntries(form, values);
  const heads = headsOf(entries);
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
      {entries.map((e, i) => (e.kind === "section"
        ? <h4 key={`s${i}`} className="pt-2 text-sm font-semibold text-gray-700 dark:text-gray-300">{e.title}</h4>
        : <ItemFields key={e.key} item={e} head={heads[i]} values={values} onChange={onChange} blank={BLANK_OPTION[form.blankStyle ?? "box"]} />))}
    </div>
  );
}

function ItemFields({ item, head, values, onChange, blank }: {
  item: FormItem; head: string; values: Record<string, unknown>; onChange: OnChange; blank: string;
}) {
  const picked = listOf(values[item.key]);
  // 同じ字の見出しが2つある書式は name で見分ける(PDF は書式の字のまま・2026-10-30)
  const name = item.name ?? item.label;
  // 読み上げの名前は、下の行なら上の番号の行の名前を頭に付ける(名前の無い行も空にしない・2026-10-30)
  const aria = `${head} ${name}`.trim();
  return (
    <div className={`space-y-1.5${item.sub ? " ml-4" : ""}`}>
      {name && (
        <p className={!item.choices?.length && !item.fields?.length
          ? "text-sm font-semibold text-gray-700 dark:text-gray-300"
          : "text-xs font-medium text-gray-600 dark:text-gray-400"}
        >
          {name}
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
        <select aria-label={aria} value={strOf(values[item.key])} onChange={(ev) => onChange(item.key, ev.target.value || null)} className={inputCls}>
          {!item.noPrint && <option value="">{blank}</option>}
          {item.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )) : null}
      {(item.fields ?? []).map((f) => (f.lines && f.lines > 1 ? (
        <textarea
          key={f.key} aria-label={fieldTexts(aria, f).ariaLabel} placeholder={fieldTexts(aria, f).placeholder} value={strOf(values[f.key])}
          onChange={(ev) => onChange(f.key, ev.target.value || null)} maxLength={f.max} rows={f.lines} className={inputCls}
        />
      ) : (
        <input
          key={f.key} type="text" aria-label={fieldTexts(aria, f).ariaLabel} placeholder={fieldTexts(aria, f).placeholder} value={strOf(values[f.key])}
          onChange={(ev) => onChange(f.key, ev.target.value || null)} maxLength={f.max} className={inputCls}
        />
      )))}
    </div>
  );
}
