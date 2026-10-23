"use client";

import { useState } from "react";
import { Building2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, SelectBox, inputCls, optionsOf } from "./form-parts";
import { dealsApi, DealApiError, errorText, type DealOptions } from "@/lib/deals/client";
import { EMPTY_PARTY_FORM, partyBodyFromForm, partyFormFromView, type PartyForm } from "@/lib/deals/forms";
import type { DealPartyView, DealView } from "@/lib/deals/view";
import { DEAL_PARTY_ROLE_LABELS, DEAL_PARTY_TYPE_LABELS } from "@/lib/deals/constants";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

/** 当事者(売主・買主・代理人・賃借人)。1件ずつ開いて直す。 */
export default function DealPartiesPanel({
  deal, selfParty, onSaved,
}: { deal: DealView; selfParty: DealOptions["selfParty"] | null; onSaved: () => Promise<void> }) {
  /** null=閉じている / "new"=新しく足す / それ以外=直している当事者の id */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<PartyForm>(EMPTY_PARTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DealPartyView | null>(null);
  const set = <K extends keyof PartyForm>(k: K, v: PartyForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const open = (p: DealPartyView | null) => {
    setError(null);
    setEditing(p ? p.id : "new");
    setForm(p ? partyFormFromView(p) : EMPTY_PARTY_FORM);
  };
  const fillSelf = () => {
    if (!selfParty) return;
    setForm((f) => ({
      ...f, partyType: "corporation", name: selfParty.name, representative: selfParty.representative ?? "",
      address: selfParty.address ?? "", phone: selfParty.phone ?? "", isSelf: true,
    }));
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const body = partyBodyFromForm(form);
    const current = deal.parties.find((p) => p.id === editing);
    return run(() => (current
      ? dealsApi.updateParty(deal.id, current.id, { version: current.version, ...body })
      : dealsApi.addParty(deal.id, body)));
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {deal.parties.length === 0 && editing === null && (
        <p className="text-sm text-gray-500 dark:text-gray-400">当事者はまだいません。「当事者を足す」から入れられます。</p>
      )}
      {deal.parties.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {deal.parties.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="w-16 text-xs text-gray-500">{DEAL_PARTY_ROLE_LABELS[p.role as keyof typeof DEAL_PARTY_ROLE_LABELS] ?? p.role}</span>
              <span className="flex-1">{p.name}{p.shareNum && p.shareDen ? `(持分 ${p.shareNum}/${p.shareDen})` : ""}</span>
              <Button variant="ghost" size="sm" onClick={() => open(p)}>直す</Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(p)}>
                <Trash2 className="h-4 w-4" />
                消す
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing === null ? (
        <Button variant="secondary" onClick={() => open(null)}>
          <Plus className="h-4 w-4" />
          当事者を足す
        </Button>
      ) : (
        <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="役割">
              <SelectBox label="役割" value={form.role} onChange={(v) => set("role", v)} options={optionsOf(DEAL_PARTY_ROLE_LABELS)} />
            </Field>
            <Field label="個人・法人">
              <SelectBox label="個人・法人" value={form.partyType} onChange={(v) => set("partyType", v)} options={optionsOf(DEAL_PARTY_TYPE_LABELS)} />
            </Field>
            <Field label="氏名(法人名)">
              <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={200} aria-label="氏名(法人名)" className={inputCls} />
            </Field>
            <Field label="代表者">
              <input value={form.representative} onChange={(e) => set("representative", e.target.value)} maxLength={100} aria-label="代表者" className={inputCls} />
            </Field>
            <Field label="住所">
              <input value={form.address} onChange={(e) => set("address", e.target.value)} maxLength={300} aria-label="住所" className={inputCls} />
            </Field>
            <Field label="連絡先">
              <input value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={50} aria-label="連絡先" className={inputCls} />
            </Field>
            <Field label="共有持分(分子)">
              <input inputMode="numeric" value={form.shareNum} onChange={(e) => set("shareNum", e.target.value)} aria-label="共有持分(分子)" className={inputCls} />
            </Field>
            <Field label="共有持分(分母)">
              <input inputMode="numeric" value={form.shareDen} onChange={(e) => set("shareDen", e.target.value)} aria-label="共有持分(分母)" className={inputCls} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={busy || !form.name.trim()} loading={busy} loadingLabel="保存中">
              <Save className="h-4 w-4" />
              保存
            </Button>
            {selfParty && (
              <Button variant="secondary" onClick={fillSelf} disabled={busy}>
                <Building2 className="h-4 w-4" />
                自社を入れる
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>やめる</Button>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title="この当事者を消しますか？"
          message={`${deleting.name} を当事者から外します。`}
          confirmLabel="消す"
          onConfirm={() => {
            const p = deleting;
            setDeleting(null);
            void run(() => dealsApi.deleteParty(deal.id, p.id, p.version));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
