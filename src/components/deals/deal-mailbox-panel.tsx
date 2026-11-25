"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { DEFAULT_MAILBOX, MAILBOX_LIMITS, MAILBOX_STATUSES, type Mailbox, type MailboxStatus } from "@/lib/deals/mailbox";
import type { DealView } from "@/lib/deals/view";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

type MailboxForm = { status: MailboxStatus; code: string; method: string; checked: boolean };
const formOf = (m: Mailbox): MailboxForm => ({ status: m.status, code: m.code ?? "", method: m.method ?? "", checked: m.checked });
// 「なし」で保存したら番号・方法は残さない(隠れたまま古い番号を持ち続けない)。
const valueOf = (f: MailboxForm): Mailbox => {
  const none = f.status === "none";
  return {
    status: f.status, code: none ? null : f.code.trim() || null, method: none ? null : f.method.trim() || null,
    checked: f.status === "present" && f.checked,
  };
};

/**
 * 集合ポストの解除番号の確認欄(取引の物件タブ・2026-11-26 発注者)。鍵受領書に解除番号と解除方法を載せる。
 * 「なし」の取引は鍵受領書に欄を出さない。
 */
export default function DealMailboxPanel({ deal, onSaved }: { deal: DealView; onSaved: () => Promise<void> }) {
  const saved = deal.mailbox ?? DEFAULT_MAILBOX;
  const [form, setForm] = useState<MailboxForm>(() => formOf(saved));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(valueOf(form)) !== JSON.stringify(saved);
  const present = form.status === "present";

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, mailbox: valueOf(form) });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-gray-200 p-4 dark:border-gray-800" aria-labelledby="deal-mailbox-title">
      <h3 id="deal-mailbox-title" className="text-sm font-semibold text-gray-800 dark:text-gray-200">集合ポスト</h3>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">集合ポストの有無</legend>
        {(Object.keys(MAILBOX_STATUSES) as MailboxStatus[]).map((s) => (
          <label key={s} className="flex items-center gap-1">
            <input type="radio" name={`mailbox-status-${deal.id}`} checked={form.status === s} onChange={() => setForm((f) => ({ ...f, status: s }))} />
            {MAILBOX_STATUSES[s]}
          </label>
        ))}
      </fieldset>
      {form.status !== "none" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="解除番号">
            <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} maxLength={MAILBOX_LIMITS.code} placeholder="例: 1234" aria-label="集合ポストの解除番号" className={inputCls} autoComplete="off" />
          </Field>
          <Field label="解除方法">
            <input value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))} maxLength={MAILBOX_LIMITS.method} placeholder="例: 右に2回まわして1、左に1回まわして2" aria-label="集合ポストの解除方法" className={inputCls} autoComplete="off" />
          </Field>
        </div>
      )}
      {present && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.checked} onChange={(e) => setForm((f) => ({ ...f, checked: e.target.checked }))} />
          現地で開くことを確認済み
        </label>
      )}
      <p className="text-xs text-gray-500">
        鍵受領書に解除番号と解除方法を載せます(空の欄は手で書く空欄で出します。「なし」のときは載せません)。
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <Button size="sm" onClick={() => void save()} disabled={busy || !dirty} loading={busy} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        集合ポストを保存
      </Button>
    </section>
  );
}
