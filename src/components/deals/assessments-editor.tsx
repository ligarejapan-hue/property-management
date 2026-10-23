"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, YenInput, inputCls } from "./form-parts";
import { bpToPercentText, parseYen, percentTextToBp, type Texted } from "@/lib/deals/money-forms";
import type { Assessments } from "@/lib/deals/schemas";

export const ASSESSMENT_MONEY_KEYS = ["building", "land"] as const;
/** 評価額は入力の文字のまま持つ(打ち間違いを 0 に置き換えない・@codex)。保存のときに読む。 */
export type AssessmentsForm = { rows: Texted<Assessments["rows"][number], (typeof ASSESSMENT_MONEY_KEYS)[number]>[]; landRatioBp: number };

/** 固都税の評価額(筆ごと・持分つき)。建物消費税の按分に使う(依頼書 3.4)。 */
export function AssessmentsEditor({ value, onChange }: { value: AssessmentsForm; onChange: (v: AssessmentsForm) => void }) {
  const setRow = (i: number, patch: Partial<AssessmentsForm["rows"][number]>) =>
    onChange({ ...value, rows: value.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">固都税の評価額(筆ごと)</h3>
      <ul className="space-y-2">
        {value.rows.map((r, i) => (
          <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_5rem_5rem_auto]">
            <Field label="家屋評価額"><YenInput label="家屋評価額" value={r.building} onChange={(v) => setRow(i, { building: v })} /></Field>
            <Field label="土地評価額"><YenInput label="土地評価額" value={r.land} onChange={(v) => setRow(i, { land: v })} /></Field>
            <Field label="持分(分子)"><ShareInput label="持分(分子)" value={r.shareNum} onCommit={(n) => setRow(i, { shareNum: n })} /></Field>
            <Field label="持分(分母)"><ShareInput label="持分(分母)" value={r.shareDen} onCommit={(n) => setRow(i, { shareDen: n })} /></Field>
            <Button variant="ghost" size="sm" onClick={() => onChange({ ...value, rows: value.rows.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" />消す</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="secondary" size="sm" disabled={value.rows.length >= 50} onClick={() => onChange({ ...value, rows: [...value.rows, { building: "", land: "", shareNum: 1, shareDen: 1 }] })}>
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

/**
 * 持分の入力。打ちかけ(空・途中)で値を書き換えないよう、欄を離れたときに読む(最終レビュー M-4)。
 * 1以上の整数でなければ元の値に戻す。
 */
function ShareInput({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) {
  return (
    <input
      key={value}
      inputMode="numeric"
      defaultValue={value}
      onBlur={(e) => {
        const n = parseYen(e.target.value);
        if (n !== null && n >= 1) onCommit(n);
        else e.target.value = String(value);
      }}
      aria-label={label}
      className={inputCls}
    />
  );
}
