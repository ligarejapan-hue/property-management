"use client";

import { useCallback, useEffect, useState } from "react";
import { ListChecks, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectBox, inputCls } from "@/components/deals/form-parts";
import { dealsApi, errorText, type UserOption } from "@/lib/deals/client";
import {
  COMPLETION_HINTS, MORTGAGE_UNKNOWN_NOTE, PRE_INTRODUCTION_NOTE, SCHEDULE_GROUPS, SCHEDULE_LIMITS, addYmdDays, scheduleBadge, scheduleGroupOf, type ScheduleGroup,
} from "@/lib/deals/schedule";
import type { ScheduleItemView } from "@/lib/deals/schedule-sync";

const BADGE_CLS = {
  done: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  muted: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  overdue: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  soon: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  normal: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
} as const;

export type ScheduleActions = {
  onUpdate: (itemId: string, body: Record<string, unknown>) => void;
  onCompletePre: () => void;
  busy?: boolean;
};

const openItem = (i: ScheduleItemView) => !i.completed && !i.excluded;

function ItemRow({ item, today, users, actions }: { item: ScheduleItemView; today: string; users: UserOption[]; actions: ScheduleActions }) {
  const badge = scheduleBadge(item, today);
  // 担当が退職などで選択肢に無くても、今の名前を出す。
  const options = users.map((u) => ({ value: u.id, label: u.name }));
  if (item.assigneeId && !users.some((u) => u.id === item.assigneeId)) options.unshift({ value: item.assigneeId, label: item.assigneeName ?? "(担当)" });
  const notes = [
    item.mortgageUnknown && openItem(item) ? MORTGAGE_UNKNOWN_NOTE : null,
    item.preIntroduction && openItem(item) ? PRE_INTRODUCTION_NOTE : null,
    item.completionHint && openItem(item) ? COMPLETION_HINTS[item.completionHint] : null,
  ].filter((n): n is string => !!n);
  return (
    <li data-schedule-item={item.id} className="grid items-center gap-2 py-2 sm:grid-cols-[1fr_9rem_10rem_auto]">
      <div className="min-w-0 space-y-0.5">
        <label className="flex items-start gap-2">
          <input
            type="checkbox" className="mt-1" checked={item.completed} disabled={item.excluded || actions.busy} aria-label={`${item.label}を完了にする`}
            onChange={(e) => actions.onUpdate(item.id, { completed: e.target.checked })}
          />
          <span className={item.completed || item.excluded ? "text-gray-500 line-through dark:text-gray-400" : "text-gray-900 dark:text-gray-100"}>{item.label}</span>
        </label>
        <p className="flex flex-wrap items-center gap-1.5 pl-5 text-xs">
          <span className={`rounded px-1.5 py-0.5 font-medium ${BADGE_CLS[badge.tone]}`}>{badge.text}</span>
          {item.autoCompleted && item.completed && <span className="text-gray-500 dark:text-gray-400">自動で完了</span>}
          {item.isManual && <span className="text-gray-500 dark:text-gray-400">手入力</span>}
          {item.dueManual && !item.isManual && <span className="text-gray-500 dark:text-gray-400">期限を手で変更</span>}
        </p>
        {notes.map((n) => <p key={n} className="pl-5 text-xs text-amber-800 dark:text-amber-300">{n}</p>)}
      </div>
      <input
        key={item.dueDate} type="date" defaultValue={item.dueDate} aria-label={`${item.label}の期限`} className={inputCls} disabled={actions.busy || item.completed}
        onBlur={(e) => { if (e.target.value && e.target.value !== item.dueDate) actions.onUpdate(item.id, { dueDate: e.target.value }); }}
      />
      <SelectBox
        label="担当" value={item.assigneeId ?? ""} options={options} allowEmpty={!item.assigneeId} disabled={actions.busy || item.completed}
        onChange={(v) => { if (v) actions.onUpdate(item.id, { assigneeId: v }); }}
      />
      {item.completed ? <span /> : item.excluded ? (
        <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.onUpdate(item.id, { excluded: false })}>戻す</Button>
      ) : (
        <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => actions.onUpdate(item.id, { excluded: true })}>対象外にする</Button>
      )}
    </li>
  );
}

/** 「決済までの段取り」の見た目。時期ごとにまとめ、期限超過・あと何日・完了が分かるようにする。 */
export function DealScheduleView({
  items, today, settlementDate, users, actions, addForm,
}: {
  items: ScheduleItemView[];
  today: string;
  settlementDate: string | null;
  users: UserOption[];
  actions: ScheduleActions;
  addForm?: React.ReactNode;
}) {
  const open = items.filter(openItem);
  const overdue = open.filter((i) => i.dueDate < today && !i.preIntroduction).length;
  const pre = open.filter((i) => i.preIntroduction).length;
  const done = items.filter((i) => i.completed).length;
  const active = items.filter((i) => !i.excluded);
  // 初めだけ決める(完了を押して超過が0件になっても、作業中に閉じない)。
  const [isOpen, setIsOpen] = useState(() => pre > 0 || open.some((i) => i.dueDate <= addYmdDays(today, 7)));
  const excluded = items.filter((i) => i.excluded);
  const groups = (Object.keys(SCHEDULE_GROUPS) as ScheduleGroup[])
    .map((g) => ({ g, rows: active.filter((i) => scheduleGroupOf(i, settlementDate) === g) }))
    .filter((x) => x.rows.length > 0);
  return (
    <details open={isOpen} onToggle={(e) => setIsOpen(e.currentTarget.open)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-800 dark:bg-gray-900">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-semibold text-gray-800 dark:text-gray-200">
        <ListChecks className="h-4 w-4" aria-hidden="true" />
        決済までの段取り
        {items.length > 0 ? (
          <span className="text-xs font-normal text-gray-600 dark:text-gray-400">
            完了 {done}/{active.length}件{overdue > 0 ? `・期限超過 ${overdue}件` : ""}
          </span>
        ) : null}
      </summary>
      {items.length === 0 && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">契約日か決済日を入れると、段取りを作ります。</p>
      )}
      {pre > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>段取りを作る前に期限が過ぎていた項目が{pre}件あります。{PRE_INTRODUCTION_NOTE}。</span>
          <Button variant="secondary" size="sm" disabled={actions.busy} onClick={actions.onCompletePre}>導入前の項目をまとめて完了にする</Button>
        </div>
      )}
      {groups.map(({ g, rows }) => (
        <section key={g} className="mt-3">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400">{SCHEDULE_GROUPS[g]}</h3>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.map((i) => <ItemRow key={i.id} item={i} today={today} users={users} actions={actions} />)}
          </ul>
        </section>
      ))}
      {excluded.length > 0 && (
        <section className="mt-3">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400">対象外</h3>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {excluded.map((i) => <ItemRow key={i.id} item={i} today={today} users={users} actions={actions} />)}
          </ul>
        </section>
      )}
      {addForm}
    </details>
  );
}

function AddItemForm({ today, users, defaultAssignee, busy, onAdd }: {
  today: string; users: UserOption[]; defaultAssignee: string | null; busy: boolean; onAdd: (body: { label: string; dueDate: string; assigneeId: string | null }) => Promise<boolean>;
}) {
  const [label, setLabel] = useState("");
  const [dueDate, setDueDate] = useState(today);
  const [assigneeId, setAssigneeId] = useState(defaultAssignee ?? "");
  const submit = async () => {
    if (!label.trim() || !dueDate) return;
    if (await onAdd({ label: label.trim(), dueDate, assigneeId: assigneeId || null })) setLabel("");
  };
  return (
    <div className="mt-3 grid items-center gap-2 border-t border-gray-100 pt-3 sm:grid-cols-[1fr_9rem_10rem_auto] dark:border-gray-800">
      <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={SCHEDULE_LIMITS.label} aria-label="足す作業名" placeholder="足す作業名" className={inputCls} />
      <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="足す作業の期限" className={inputCls} />
      <SelectBox label="担当" value={assigneeId} onChange={setAssigneeId} options={users.map((u) => ({ value: u.id, label: u.name }))} allowEmpty />
      <Button variant="secondary" size="sm" disabled={busy || !label.trim() || !dueDate} onClick={() => void submit()}>
        <Plus className="h-4 w-4" />
        足す
      </Button>
    </div>
  );
}

/** 読んで出す。取引の保存・書類の発行で読み直す。 */
export function DealSchedule({ dealId, users, defaultAssignee, revision }: { dealId: string; users: UserOption[]; defaultAssignee: string | null; revision: string }) {
  const [data, setData] = useState<{ items: ScheduleItemView[]; today: string; settlementDate: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await dealsApi.schedule(dealId);
    setData(res);
    setError(null);
  }, [dealId]);

  useEffect(() => {
    let alive = true;
    dealsApi.schedule(dealId)
      .then((res) => { if (alive) { setData(res); setError(null); } })
      .catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [dealId, revision]);

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p> : null;
  return (
    <div className="space-y-1">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <DealScheduleView
        items={data.items} today={data.today} settlementDate={data.settlementDate} users={users}
        actions={{
          busy,
          onUpdate: (itemId, body) => void run(() => dealsApi.updateScheduleItem(dealId, itemId, body)),
          onCompletePre: () => void run(() => dealsApi.completePreScheduleItems(dealId)),
        }}
        addForm={
          <AddItemForm
            today={data.today} users={users} defaultAssignee={defaultAssignee} busy={busy}
            onAdd={(body) => run(() => dealsApi.addScheduleItem(dealId, body))}
          />
        }
      />
    </div>
  );
}
