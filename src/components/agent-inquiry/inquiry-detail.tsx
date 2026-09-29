"use client";

import { useCallback, useEffect, useState } from "react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import {
  addAgentViewing,
  apiErrorCode,
  fetchAgentInquiry,
  updateAgentInquiry,
  updateAgentViewing,
  type InquiryStatusKey,
  type InquiryView,
  type ViewingTypeKey,
  type ViewingView,
} from "@/lib/api-client";
import {
  CONFLICT_MESSAGE,
  KIND_LABEL,
  STATUS_LABEL,
  VIEWING_TYPE_LABEL,
  formatJst,
  isoToJstInputs,
  jstInputsToIso,
} from "@/lib/agent-inquiry/desk-form";

export const mainWindowPropertyHref = (id: string) => `/properties/${id}`;
const inputCls = "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900";

export type ViewingPatch = {
  scheduledAt?: string | null;
  viewingType?: ViewingTypeKey;
  attendantId?: string | null;
  resultNote?: string | null;
  canceled?: boolean;
};

function ViewingRow({
  v,
  users,
  busy,
  onSave,
}: {
  v: ViewingView;
  users: { id: string; name: string }[];
  busy: boolean;
  onSave: (patch: ViewingPatch) => void;
}) {
  const init = isoToJstInputs(v.scheduledAt);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [result, setResult] = useState(v.resultNote ?? "");
  const canceled = v.canceledAt != null;
  return (
    <li className={`space-y-1 rounded-md border border-gray-200 p-2 dark:border-gray-700 ${canceled ? "opacity-60" : ""}`}>
      <p className="text-sm font-medium tabular-nums">
        {formatJst(v.scheduledAt)} {VIEWING_TYPE_LABEL[v.viewingType]}
        {v.attendant ? ` ・ 立会 ${v.attendant.name}` : ""}
        {canceled ? " ・ 取り消し済み" : ""}
      </p>
      <div className="grid grid-cols-2 gap-1">
        <input type="date" value={date} aria-label="内見の日付" onChange={(e) => setDate(e.target.value)} className={inputCls} />
        <input type="time" value={time} aria-label="内見の時刻" onChange={(e) => setTime(e.target.value)} className={inputCls} />
      </div>
      <select
        defaultValue={v.attendant?.id ?? ""}
        disabled={busy}
        aria-label="立ち会い"
        onChange={(e) => onSave({ attendantId: e.target.value || null })}
        className={inputCls}
      >
        <option value="">立ち会い なし・未定</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <textarea
        value={result}
        onChange={(e) => setResult(e.target.value)}
        rows={2}
        placeholder="内見後の結果"
        className={inputCls}
      />
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave({ scheduledAt: jstInputsToIso(date, time), resultNote: result })}
          className="rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60"
        >
          日時と結果を保存
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave({ canceled: !canceled })}
          className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
        >
          {canceled ? "取り消しを戻す" : "この内見を取り消す"}
        </button>
      </div>
    </li>
  );
}

/** 見た目(SSR テスト用)。 */
export function InquiryDetailView({
  inquiry: q,
  canOpenProperty,
  users,
  busy,
  error,
  onStatus,
  onAssignee,
  onSaveNote,
  onAddViewing,
  onSaveViewing,
  onClose,
  onReload,
}: {
  inquiry: InquiryView;
  canOpenProperty: boolean;
  users: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  onStatus: (s: InquiryStatusKey) => void;
  onAssignee: (id: string | null) => void;
  onSaveNote: (note: string) => void;
  onAddViewing: (t: ViewingTypeKey) => void;
  onSaveViewing: (v: ViewingView, patch: ViewingPatch) => void;
  onClose: () => void;
  /** 他の人が先に更新したとき、入力を残したまま最新を読み直す。 */
  onReload?: () => void;
}) {
  const [note, setNote] = useState(q.note ?? "");
  return (
    <ModalShell
      size="lg"
      title={`${KIND_LABEL[q.kind]} ― ${q.agent.companyName}`}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          閉じる
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="font-medium">
          {q.property.roomNo ? `${q.property.name} ${q.property.roomNo}` : q.property.name}
          <span className="ml-2 text-xs text-gray-500">{q.property.town}</span>
        </p>
        {canOpenProperty && (
          // 素の <a target> で名前付きの窓に開く(window.open はブロックされる環境がある)。
          <a href={mainWindowPropertyHref(q.property.id)} target="pm-main" className="text-teal-700 underline dark:text-teal-300">
            メイン画面で物件を開く ↗
          </a>
        )}
        <p>
          問い合わせ者:{q.contactName ?? "—"} ・ 携帯 {q.contactMobile ?? "—"} ・ メール {q.contactEmail ?? "—"}
        </p>
        <p className="text-xs text-gray-500">
          受けた日時 {formatJst(q.receivedAt)} ・ 代表 {q.agent.phone}
        </p>
        <div className="grid grid-cols-3 gap-1">
          {(["open", "in_progress", "done"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => onStatus(s)}
              className={`rounded-md border px-2 py-2 ${
                q.status === s ? "border-teal-700 bg-teal-700 font-bold text-white" : "border-gray-300 dark:border-gray-700"
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-xs text-gray-500">担当</span>
          <select
            defaultValue={q.assignee?.id ?? ""}
            disabled={busy}
            onChange={(e) => onAssignee(e.target.value || null)}
            className={inputCls}
          >
            <option value="">未定</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">メモ</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={inputCls} />
          <button
            type="button"
            disabled={busy}
            onClick={() => onSaveNote(note)}
            className="mt-1 rounded bg-teal-700 px-3 py-1 text-xs text-white disabled:opacity-60"
          >
            メモを保存
          </button>
        </label>
        {q.kind === "viewing" && (
          <div className="space-y-1">
            <p className="text-xs text-gray-500">内見の予定</p>
            <ul className="space-y-1">
              {q.viewings.map((v) => (
                <ViewingRow key={`${v.id}:${v.version}`} v={v} users={users} busy={busy} onSave={(p) => onSaveViewing(v, p)} />
              ))}
            </ul>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => onAddViewing("guided")}
                className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
              >
                内見を足す(案内)
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAddViewing("preview")}
                className="rounded border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
              >
                内見を足す(下見)
              </button>
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-between gap-2 rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950 dark:text-rose-200">
            <p>{error}</p>
            {onReload && (
              <button type="button" onClick={onReload} className="shrink-0 rounded border border-rose-300 px-2 py-0.5 text-xs">
                読み直す
              </button>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

/** 取得・保存を持つ親。保存のたびに読み直し、409 は文言を出してから読み直す(入力中の内容は各欄が持つ)。 */
export default function InquiryDetail({
  inquiryId,
  users,
  onClose,
  onChanged,
}: {
  inquiryId: string;
  users: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<{ inquiry: InquiryView; canOpenProperty: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => fetchAgentInquiry(inquiryId).then(setData), [inquiryId]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "読み込めませんでした"));
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let conflict = false;
    try {
      await fn();
      onChanged();
    } catch (e) {
      conflict = apiErrorCode(e) === "VERSION_CONFLICT";
      setError(conflict ? CONFLICT_MESSAGE : e instanceof Error ? e.message : "保存できませんでした");
    } finally {
      // 他の人が先に更新したときは自動で読み直さない=打ちかけの入力を消さない。「読み直す」で最新へ。
      if (!conflict) await load().catch(() => {});
      setBusy(false);
    }
  };
  const reload = () => {
    setError(null);
    load().catch((e) => setError(e instanceof Error ? e.message : "読み込めませんでした"));
  };
  if (!data) {
    return error ? (
      <ModalShell size="sm" title="反響" onClose={onClose} footer={<Button onClick={onClose}>閉じる</Button>}>
        <p className="text-sm text-rose-600">{error}</p>
      </ModalShell>
    ) : null;
  }
  const q = data.inquiry;
  return (
    <InquiryDetailView
      key={`${q.id}:${q.version}`}
      inquiry={q}
      canOpenProperty={data.canOpenProperty}
      users={users}
      busy={busy}
      error={error}
      onStatus={(status) => run(() => updateAgentInquiry(q.id, { version: q.version, status }))}
      onAssignee={(assigneeId) => run(() => updateAgentInquiry(q.id, { version: q.version, assigneeId }))}
      onSaveNote={(note) => run(() => updateAgentInquiry(q.id, { version: q.version, note }))}
      onAddViewing={(viewingType) => run(() => addAgentViewing(q.id, { viewingType }))}
      onSaveViewing={(v, patch) => run(() => updateAgentViewing(q.id, v.id, { version: v.version, ...patch }))}
      onClose={onClose}
      onReload={reload}
    />
  );
}
