"use client";

import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectBox, inputCls, optionsOf } from "@/components/deals/form-parts";
import type { ScheduleTemplateItem } from "@/lib/deals/schedule";
import {
  DEFAULT_REQUEST_TEMPLATES, REQUEST_FIELD_GROUPS, REQUEST_LIMITS, REQUEST_RECIPIENTS,
  type RequestRecipient, type RequestTemplate,
} from "@/lib/deals/request-drafts/templates";

/** 新しいひな形の鍵(英小文字・数字・_)。押したときに作る。 */
const newId = () => `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const NOT_LINKED = "";

/** 結びつけられる段取りの項目。段取りのひな形から消した項目を結んでいても、消えたことが分かるように残す。 */
export function scheduleItemOptions(items: Pick<ScheduleTemplateItem, "id" | "label">[], current: string | null) {
  const options = [{ value: NOT_LINKED, label: "結びつけない" }, ...items.map((i) => ({ value: i.id, label: i.label }))];
  if (current && !items.some((i) => i.id === current)) options.push({ value: current, label: "(段取りのひな形から消した項目)" });
  return options;
}

/** 依頼文のひな形(取引の設定)。保存は設定の画面の「保存」ボタンで一緒に送る。 */
export function RequestTemplateEditor({ items, scheduleItems, onChange }: {
  items: RequestTemplate[]; scheduleItems: Pick<ScheduleTemplateItem, "id" | "label">[]; onChange: (items: RequestTemplate[]) => void;
}) {
  const patch = (id: string, p: Partial<RequestTemplate>) => onChange(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const add = () => onChange([...items, { id: newId(), label: "", recipient: "other", scheduleItemKey: null, body: "" }]);
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-gray-100 p-2 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400">
        <p className="font-medium">使える差し込み欄({"{{物件名}}"} のように書きます)</p>
        <ul className="mt-1 space-y-0.5">
          {REQUEST_FIELD_GROUPS.map(([group, fields]) => <li key={group}>{group}:{fields.join("・")}</li>)}
        </ul>
      </div>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.id} className="space-y-2 rounded-md border border-gray-100 p-2 dark:border-gray-800">
            <div className="grid items-center gap-2 sm:grid-cols-[2fr_1fr_2fr_auto]">
              <input
                value={i.label} onChange={(e) => patch(i.id, { label: e.target.value })} maxLength={REQUEST_LIMITS.label}
                aria-label="ひな形の名前" placeholder="ひな形の名前" className={inputCls}
              />
              <SelectBox label="相手" value={i.recipient} onChange={(v) => patch(i.id, { recipient: v as RequestRecipient })} options={optionsOf(REQUEST_RECIPIENTS)} />
              <SelectBox
                label="結びつける段取りの項目" value={i.scheduleItemKey ?? NOT_LINKED} options={scheduleItemOptions(scheduleItems, i.scheduleItemKey)}
                onChange={(v) => patch(i.id, { scheduleItemKey: v === NOT_LINKED ? null : v })}
              />
              <Button variant="ghost" size="sm" disabled={items.length <= 1} onClick={() => onChange(items.filter((x) => x.id !== i.id))}>
                <Trash2 className="h-4 w-4" />
                消す
              </Button>
            </div>
            <textarea
              value={i.body} onChange={(e) => patch(i.id, { body: e.target.value })} maxLength={REQUEST_LIMITS.body} rows={6}
              aria-label="ひな形の本文" placeholder="本文" className={inputCls}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={add} disabled={items.length >= REQUEST_LIMITS.items}>
          <Plus className="h-4 w-4" />
          ひな形を足す
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_REQUEST_TEMPLATES)}>
          <RotateCcw className="h-4 w-4" />
          初めのひな形に戻す
        </Button>
      </div>
    </div>
  );
}
