"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, YenInput, inputCls } from "./form-parts";
import { bpToPercentText, parseYen, percentTextToBp } from "@/lib/deals/money-forms";
import type { Assessments } from "@/lib/deals/schemas";

/** 固都税の評価額(筆ごと・持分つき)。建物消費税の按分に使う(依頼書 3.4)。 */
export function AssessmentsEditor({ value, onChange }: { value: Assessments; onChange: (v: Assessments) => void }) {
  const setRow = (i: number, patch: Partial<Assessments["rows"][number]>) =>
    onChange({ ...value, rows: value.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">固都税の評価額(筆ごと)</h3>
      <ul className="space-y-2">
        {value.rows.map((r, i) => (
          <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_5rem_5rem_auto]">
            <Field label="家屋評価額"><YenInput label="家屋評価額" value={String(r.building)} onChange={(v) => setRow(i, { building: parseYen(v) ?? 0 })} /></Field>
            <Field label="土地評価額"><YenInput label="土地評価額" value={String(r.land)} onChange={(v) => setRow(i, { land: parseYen(v) ?? 0 })} /></Field>
            <Field label="持分(分子)"><input inputMode="numeric" value={r.shareNum} onChange={(e) => setRow(i, { shareNum: Math.max(1, parseYen(e.target.value) ?? 1) })} aria-label="持分(分子)" className={inputCls} /></Field>
            <Field label="持分(分母)"><input inputMode="numeric" value={r.shareDen} onChange={(e) => setRow(i, { shareDen: Math.max(1, parseYen(e.target.value) ?? 1) })} aria-label="持分(分母)" className={inputCls} /></Field>
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...value, rows: value.rows.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" />消す</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="secondary" size="sm" disabled={value.rows.length >= 50} onClick={() => onChange({ ...value, rows: [...value.rows, { building: 0, land: 0, shareNum: 1, shareDen: 1 }] })}>
          <Plus className="h-4 w-4" />
          筆を足す
        </Button>
        <Field label="土地の割合(%)" hint="借地権などのとき。ふつうは100">
          <input
            inputMode="decimal"
            defaultValue={bpToPercentText(value.landRatioBp)}
            onBlur={(e) => {
              const bp = percentTextToBp(e.target.value);
              if (bp !== null && bp <= 10000) onChange({ ...value, landRatioBp: bp });
              else e.target.value = bpToPercentText(value.landRatioBp);
            }}
            aria-label="土地の割合"
            className={inputCls}
          />
        </Field>
      </div>
    </section>
  );
}
