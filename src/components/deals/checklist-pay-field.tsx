"use client";

import { CHECKLIST_PAY_METHODS, CHECKLIST_PAY_OTHER_MAX, type ChecklistPayMethod } from "@/lib/deals/checklist";
import { parseYen, yenText } from "@/lib/deals/money-forms";
import { inputCls } from "./form-parts";

/** 書類確認書の持参する金額の払い方(1つ分)。サーバーの checklistOptionsSchema と同じ形。 */
export type PayEntryValue = { method: ChecklistPayMethod; amount: number | null; other: string | null };

const METHODS = Object.keys(CHECKLIST_PAY_METHODS) as ChecklistPayMethod[];
const isMethod = (v: unknown): v is ChecklistPayMethod => typeof v === "string" && (METHODS as string[]).includes(v);

/** 画面の値 → 払い方の並び(形の合わないものは捨てる・並びは選択肢の順)。 */
export function payEntriesOf(v: unknown): PayEntryValue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is PayEntryValue => !!e && typeof e === "object" && isMethod((e as PayEntryValue).method))
    .map((e) => ({ method: e.method, amount: typeof e.amount === "number" ? e.amount : null, other: typeof e.other === "string" ? e.other : null }))
    .sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
}

/** 送る形に整える: 金額は2つ以上選んだときだけ・手入力は「その他」のときだけ。 */
export function payEntriesToSend(entries: PayEntryValue[]): PayEntryValue[] {
  const multi = entries.length > 1;
  return entries.map((e) => ({
    method: e.method, amount: multi ? e.amount : null, other: e.method === "other" ? e.other?.trim() || null : null,
  }));
}

/** 2つ以上選んで金額がすべて入っているのに、合計が持参する金額と違うか。 */
export function payBreakdownGap(entries: PayEntryValue[], total: number | null): number | null {
  if (entries.length < 2 || total === null || entries.some((e) => e.amount === null)) return null;
  const sum = entries.reduce((n, e) => n + (e.amount ?? 0), 0);
  return sum === total ? null : sum;
}

/**
 * 持参する金額の払い方。現金・振込・小切手・その他をいくつでも選べる。
 * 2つ以上選んだら、それぞれに金額を入れる。「その他」だけ手入力の欄を出す(2026-11-05 発注者)。
 */
export function PayMethodsField({
  label, total, value, onChange,
}: {
  label: string;
  total: number | null;
  value: PayEntryValue[];
  onChange: (v: PayEntryValue[]) => void;
}) {
  const multi = value.length > 1;
  const entryOf = (m: ChecklistPayMethod) => value.find((e) => e.method === m) ?? null;
  const toggle = (m: ChecklistPayMethod, on: boolean) =>
    onChange(payEntriesOf(on ? [...value, { method: m, amount: null, other: null }] : value.filter((e) => e.method !== m)));
  const patch = (m: ChecklistPayMethod, p: Partial<PayEntryValue>) => onChange(value.map((e) => (e.method === m ? { ...e, ...p } : e)));
  const gap = payBreakdownGap(value, total);
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">{label}の払い方</legend>
      {METHODS.map((m) => {
        const e = entryOf(m);
        const name = CHECKLIST_PAY_METHODS[m];
        return (
          <div key={m} className="flex flex-wrap items-center gap-2">
            <label className="inline-flex min-w-[5rem] items-center gap-1.5 text-sm">
              <input type="checkbox" checked={!!e} onChange={(ev) => toggle(m, ev.target.checked)} aria-label={`${label}を${name}で払う`} />
              {name}
            </label>
            {e && m === "other" && (
              <span className="w-44">
                <input
                  value={e.other ?? ""} maxLength={CHECKLIST_PAY_OTHER_MAX} placeholder="払い方を入力"
                  onChange={(ev) => patch(m, { other: ev.target.value })} aria-label={`${label}のその他の払い方`} className={inputCls}
                />
              </span>
            )}
            {e && multi && (
              <span className="w-40">
                <input
                  inputMode="numeric" value={e.amount === null ? "" : String(e.amount)} placeholder="金額(円)"
                  onChange={(ev) => patch(m, { amount: parseYen(ev.target.value) })} aria-label={`${label}の${name}の金額`} className={inputCls}
                />
              </span>
            )}
          </div>
        );
      })}
      {multi && value.some((x) => x.amount === null) && (
        <p className="text-xs text-gray-500">2つ以上選んだときは、それぞれの金額を入れてください(空の払い方は名前だけ出します)。</p>
      )}
      {gap !== null && total !== null && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="status">内訳の合計 {yenText(gap)}円が、金額 {yenText(total)}円と違います。</p>
      )}
    </fieldset>
  );
}
