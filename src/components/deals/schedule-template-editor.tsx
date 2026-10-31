"use client";

import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import {
  DEFAULT_SCHEDULE_TEMPLATE, SCHEDULE_ASSIGNEE_RULES, SCHEDULE_BASES, SCHEDULE_CONDITIONS, SCHEDULE_LIMITS, SCHEDULE_TRADE_SCOPES,
  type ScheduleAssigneeRule, type ScheduleBase, type ScheduleCondition, type ScheduleTemplateItem, type ScheduleTradeScope,
} from "@/lib/deals/schedule";

/** 新しい項目の鍵(英小文字・数字・_)。押したときに作る。 */
const newId = () => `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/** 「-7」「−7」「7」「+7」を日数にする。読めない・範囲外は null。 */
export function parseOffsetDays(v: string): number | null {
  const m = /^\s*([-−ー+＋]?)\s*(\d{1,3})\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[2]);
  if (n > SCHEDULE_LIMITS.offsetDays) return null;
  return m[1] === "-" || m[1] === "−" || m[1] === "ー" ? (n === 0 ? 0 : -n) : n;
}

/**
 * 段取りのひな形(取引の設定)。保存は設定の画面の「保存」ボタンで一緒に送る。
 * 日数は打ちかけで固まらないよう、離れたときに確定する。
 */
export function ScheduleTemplateEditor({ items, onChange }: { items: ScheduleTemplateItem[]; onChange: (items: ScheduleTemplateItem[]) => void }) {
  const patch = (id: string, p: Partial<ScheduleTemplateItem>) => onChange(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const add = () => onChange([...items, { id: newId(), label: "", base: "settlement", offsetDays: 0, tradeScope: "all", condition: "all", assigneeRule: "assignee" }]);
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.id} className="grid items-center gap-2 rounded-md border border-gray-100 p-2 sm:grid-cols-[2fr_1fr_5rem_1.4fr_1.4fr_1.1fr_auto] dark:border-gray-800">
            <input
              value={i.label} onChange={(e) => patch(i.id, { label: e.target.value })} maxLength={SCHEDULE_LIMITS.label}
              aria-label="作業名" placeholder="作業名" className={inputCls}
            />
            <SelectBox label="基準日" value={i.base} onChange={(v) => patch(i.id, { base: v as ScheduleBase })} options={optionsOf(SCHEDULE_BASES)} />
            <input
              key={`${i.id}:${i.offsetDays}`} defaultValue={String(i.offsetDays)} inputMode="numeric" aria-label="基準日から何日(前はマイナス)" title="基準日から何日(前はマイナス)" className={inputCls}
              onBlur={(e) => {
                const n = parseOffsetDays(e.target.value);
                if (n === null) e.target.value = String(i.offsetDays);
                else if (n !== i.offsetDays) patch(i.id, { offsetDays: n });
              }}
            />
            <SelectBox label="対象の取引" value={i.tradeScope} onChange={(v) => patch(i.id, { tradeScope: v as ScheduleTradeScope })} options={optionsOf(SCHEDULE_TRADE_SCOPES)} />
            <SelectBox label="条件" value={i.condition} onChange={(v) => patch(i.id, { condition: v as ScheduleCondition })} options={optionsOf(SCHEDULE_CONDITIONS)} />
            <SelectBox label="担当の決め方" value={i.assigneeRule} onChange={(v) => patch(i.id, { assigneeRule: v as ScheduleAssigneeRule })} options={optionsOf(SCHEDULE_ASSIGNEE_RULES)} />
            <Button variant="ghost" size="sm" disabled={items.length <= 1} onClick={() => onChange(items.filter((x) => x.id !== i.id))}>
              <Trash2 className="h-4 w-4" />
              消す
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={add} disabled={items.length >= SCHEDULE_LIMITS.items}>
          <Plus className="h-4 w-4" />
          項目を足す
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_SCHEDULE_TEMPLATE)}>
          <RotateCcw className="h-4 w-4" />
          初めの項目に戻す
        </Button>
      </div>
    </div>
  );
}
