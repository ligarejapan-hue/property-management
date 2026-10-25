"use client";

import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import {
  CHECKLIST_AMOUNTS, CHECKLIST_GROUPS, CHECKLIST_LIMITS, CHECKLIST_PHASES, CHECKLIST_SCOPES, DEFAULT_CHECKLIST_ITEMS,
  type ChecklistAmount, type ChecklistGroup, type ChecklistItem, type ChecklistPhase, type ChecklistScope,
} from "@/lib/deals/checklist";

/** 新しい項目の鍵(英小文字・数字・_)。押したときに作る。 */
const newId = () => `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * 書類確認書の項目(取引の設定)。契約時・決済時 × 3つのまとまりごとに、項目・注意事項・出す取引・金額を直す。
 * 金額は「持参するもの」だけ。保存は設定の画面の「保存」ボタンで一緒に送る。
 */
export function ChecklistItemsEditor({ items, onChange }: { items: ChecklistItem[]; onChange: (items: ChecklistItem[]) => void }) {
  const patch = (id: string, p: Partial<ChecklistItem>) => onChange(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const add = (phase: ChecklistPhase, group: ChecklistGroup) => {
    // まとまりの最後の項目のすぐ後ろに足す(並びは書類の並び)。
    const at = items.reduce((last, i, n) => (i.phase === phase && i.group === group ? n : last), items.length - 1);
    const item: ChecklistItem = { id: newId(), phase, group, label: "", note: null, scope: "all", amount: null };
    onChange([...items.slice(0, at + 1), item, ...items.slice(at + 1)]);
  };

  return (
    <div className="space-y-4">
      {(Object.keys(CHECKLIST_PHASES) as ChecklistPhase[]).map((phase) => (
        <div key={phase} className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{CHECKLIST_PHASES[phase]}</h3>
          {(Object.keys(CHECKLIST_GROUPS) as ChecklistGroup[]).map((group) => {
            const rows = items.filter((i) => i.phase === phase && i.group === group);
            return (
              <div key={group} className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">{CHECKLIST_GROUPS[group]}</h4>
                <ul className="space-y-2">
                  {rows.map((i) => (
                    <li key={i.id} className="grid items-center gap-2 sm:grid-cols-[2fr_2fr_1.4fr_1.2fr_auto]">
                      <input
                        value={i.label} onChange={(e) => patch(i.id, { label: e.target.value })} maxLength={CHECKLIST_LIMITS.label}
                        aria-label="項目" placeholder="項目" className={inputCls}
                      />
                      <input
                        value={i.note ?? ""} onChange={(e) => patch(i.id, { note: e.target.value || null })} maxLength={CHECKLIST_LIMITS.note}
                        aria-label="注意事項" placeholder="注意事項" className={inputCls}
                      />
                      <SelectBox label="出す取引" value={i.scope} onChange={(v) => patch(i.id, { scope: v as ChecklistScope })} options={optionsOf(CHECKLIST_SCOPES)} />
                      {group === "bring" ? (
                        <SelectBox
                          label="金額" value={i.amount ?? ""} onChange={(v) => patch(i.id, { amount: (v || null) as ChecklistAmount | null })}
                          options={optionsOf(CHECKLIST_AMOUNTS)} allowEmpty
                        />
                      ) : <span />}
                      <Button variant="ghost" size="sm" disabled={items.length <= 1} onClick={() => onChange(items.filter((x) => x.id !== i.id))}>
                        <Trash2 className="h-4 w-4" />
                        消す
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button variant="secondary" size="sm" onClick={() => add(phase, group)} disabled={items.length >= CHECKLIST_LIMITS.items}>
                  <Plus className="h-4 w-4" />
                  項目を足す
                </Button>
              </div>
            );
          })}
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_CHECKLIST_ITEMS)}>
        <RotateCcw className="h-4 w-4" />
        初めの項目に戻す
      </Button>
    </div>
  );
}
