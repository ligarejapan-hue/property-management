"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, inputCls, optionsOf } from "./form-parts";
import { DealBrokerSearch } from "./deal-broker-search";
import { DealPlaceField } from "./deal-place-field";
import { dealsApi, DealApiError, errorText, type UserOption } from "@/lib/deals/client";
import { applyBrokerPick, basicFormFromDeal, basicPatch, type BasicForm } from "@/lib/deals/forms";
import { placeProblem } from "@/lib/deals/place";
import type { DealView } from "@/lib/deals/view";
import {
  DEAL_BUSINESS_TYPE_LABELS, DEAL_STATUS_LABELS, DEAL_TRADE_SIDE_LABELS, type PropertyKindDef,
} from "@/lib/deals/constants";

export default function DealBasicPanel({
  deal, users, kinds, onSaved,
}: { deal: DealView; users: UserOption[]; kinds: PropertyKindDef[]; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<BasicForm>(() => basicFormFromDeal(deal));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const set = <K extends keyof BasicForm>(k: K, v: BasicForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));
  const patch = basicPatch(form, deal);
  const dirty = Object.keys(patch).length > 0;
  const placeBlocked = placeProblem(form.contractPlace) !== null || placeProblem(form.settlementPlace) !== null;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setMessage(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, ...patch });
      await onSaved();
    } catch (e) {
      const text = e instanceof DealApiError && e.code === "VERSION_CONFLICT"
        ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
        : errorText(e);
      setMessage({ kind: "err", text });
    } finally {
      setSaving(false);
    }
  };

  const staff = (k: "assigneeId" | "licensedAgentId" | "salesStaffId" | "opsStaffId", label: string) => (
    <Field label={label}>
      <SelectBox label={label} value={form[k]} onChange={(v) => set(k, v)} options={userOptions} allowEmpty />
    </Field>
  );

  return (
    <div className="space-y-5">
      {message && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{message.text}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="状態" hint={deal.propertyId ? "物件の案件ステータスと連動します" : undefined}>
          <SelectBox label="状態"value={form.status} onChange={(v) => set("status", v)} options={optionsOf(DEAL_STATUS_LABELS)} />
        </Field>
        <Field label="事業区分">
          <SelectBox label="事業区分" value={form.businessType} onChange={(v) => set("businessType", v)} options={optionsOf(DEAL_BUSINESS_TYPE_LABELS)} />
        </Field>
        {form.businessType === "brokerage" ? (
          <Field label="取引態様">
            <SelectBox label="取引態様" value={form.tradeSide} onChange={(v) => set("tradeSide", v)} options={optionsOf(DEAL_TRADE_SIDE_LABELS)} allowEmpty />
          </Field>
        ) : (
          <p className="self-end pb-2 text-xs text-gray-500">買取再販では、自社が買主にも売主にもなります。</p>
        )}
        <Field label="物件種別">
          <SelectBox label="物件種別" value={form.propertyKind} onChange={(v) => set("propertyKind", v)} options={kinds.map((k) => ({ value: k.key, label: k.label }))} allowEmpty />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={form.hasOc} onChange={(e) => set("hasOc", e.target.checked)} />
          オーナーチェンジ(賃貸中のまま売買)
        </label>
      </div>

      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">担当</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {staff("assigneeId", "担当者")}
        {staff("licensedAgentId", "宅建士")}
        {staff("salesStaffId", "営業担当")}
        {staff("opsStaffId", "業務担当")}
      </div>

      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">契約・決済</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="契約日時">
          <input type="datetime-local" value={form.contractAt} onChange={(e) => set("contractAt", e.target.value)} aria-label="契約日時" className={inputCls} />
        </Field>
        <DealPlaceField label="契約場所" allowBank={false} value={form.contractPlace} onChange={(v) => set("contractPlace", v)} />
        <Field label="決済日時">
          <input type="datetime-local" value={form.settlementAt} onChange={(e) => set("settlementAt", e.target.value)} aria-label="決済日時" className={inputCls} />
        </Field>
        <DealPlaceField label="決済場所" allowBank value={form.settlementPlace} onChange={(v) => set("settlementPlace", v)} />
      </div>

      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">相手方の仲介会社</h3>
      <DealBrokerSearch onPick={(hit) => setForm((f) => applyBrokerPick(f, hit))} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="会社名">
          <input value={form.brokerCompany} onChange={(e) => set("brokerCompany", e.target.value)} maxLength={200} aria-label="相手方の仲介会社" className={inputCls} />
        </Field>
        <Field label="担当">
          <input value={form.brokerStaff} onChange={(e) => set("brokerStaff", e.target.value)} maxLength={100} aria-label="相手方の担当" className={inputCls} />
        </Field>
        <Field label="電話">
          <input value={form.brokerTel} onChange={(e) => set("brokerTel", e.target.value)} maxLength={50} aria-label="相手方の電話" className={inputCls} />
        </Field>
      </div>

      <Button onClick={save} disabled={saving || !dirty || placeBlocked} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>
    </div>
  );
}
