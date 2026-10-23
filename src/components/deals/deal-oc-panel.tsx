"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, SelectBox, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { parseYen, yenText } from "@/lib/deals/money-forms";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import type { Lease, SettlementTerms } from "@/lib/deals/schemas";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
const EMPTY_LEASE: Lease = {
  room: null, tenant: null, contractType: "ordinary", period: null, rent: 0, commonFee: 0, parking: 0, other: 0,
  deposit: 0, arrears: false, arrearsAmount: 0, manager: null,
};
type MoneyKey = "rent" | "commonFee" | "parking" | "other" | "deposit";
const MONEY: [MoneyKey, string][] = [["rent", "賃料"], ["commonFee", "共益費"], ["parking", "駐車場代"], ["other", "その他"], ["deposit", "預り敷金(保証金)"]];

/** OC(オーナーチェンジ)の賃貸条件。一棟なら部屋ごとに複数行。 */
export default function DealOcPanel({ deal, calc, onSaved }: { deal: DealView; calc: DealCalc | null; onSaved: () => Promise<void> }) {
  const [leases, setLeases] = useState<Lease[]>(deal.leases);
  const [depositMode, setDepositMode] = useState<SettlementTerms["depositMode"]>(deal.settlementTerms.depositMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Lease>) => setLeases((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const txt = (v: string) => (v.trim() === "" ? null : v);
  const monthly = leases.reduce((a, l) => a + l.rent + l.commonFee + l.parking + l.other, 0);
  const deposits = leases.reduce((a, l) => a + l.deposit, 0);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, { version: deal.version, leases, settlementTerms: { ...deal.settlementTerms, depositMode } });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <p className="text-sm tabular-nums">月額の合計 {yenText(monthly)}円 ・ 預り敷金の合計 {yenText(deposits)}円 ・ 精算: {calc?.settlement.depositRow?.note ?? "—"}</p>
      <Field label="敷金の扱い">
        <SelectBox label="敷金の扱い" value={depositMode} onChange={(v) => setDepositMode(v as SettlementTerms["depositMode"])} options={[{ value: "offset", label: "残代金と相殺" }, { value: "separate", label: "別途授受" }]} />
      </Field>
      {leases.map((l, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="部屋番号"><input value={l.room ?? ""} onChange={(e) => set(i, { room: txt(e.target.value) })} maxLength={30} aria-label="部屋番号" className={inputCls} /></Field>
            <Field label="賃借人"><input value={l.tenant ?? ""} onChange={(e) => set(i, { tenant: txt(e.target.value) })} maxLength={100} aria-label="賃借人" className={inputCls} /></Field>
            <Field label="契約形態">
              <SelectBox label="契約形態" value={l.contractType} onChange={(v) => set(i, { contractType: v as Lease["contractType"] })} options={[{ value: "ordinary", label: "普通借家" }, { value: "fixed_term", label: "定期借家" }]} />
            </Field>
            <Field label="契約期間"><input value={l.period ?? ""} onChange={(e) => set(i, { period: txt(e.target.value) })} maxLength={100} aria-label="契約期間" className={inputCls} /></Field>
            {MONEY.map(([k, label]) => (
              <Field key={k} label={label}><YenInput label={label} value={String(l[k])} onChange={(v) => set(i, { [k]: parseYen(v) ?? 0 })} /></Field>
            ))}
            <Field label="管理会社"><input value={l.manager ?? ""} onChange={(e) => set(i, { manager: txt(e.target.value) })} maxLength={100} aria-label="管理会社" className={inputCls} /></Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={l.arrears} onChange={(e) => set(i, { arrears: e.target.checked })} />
              滞納あり
            </label>
            {l.arrears && <Field label="滞納の金額"><YenInput label="滞納の金額" value={String(l.arrearsAmount)} onChange={(v) => set(i, { arrearsAmount: parseYen(v) ?? 0 })} /></Field>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLeases((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" />この部屋を消す</Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={leases.length >= 200} onClick={() => setLeases((ls) => [...ls, EMPTY_LEASE])}>
          <Plus className="h-4 w-4" />
          部屋を足す
        </Button>
        <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
          <Save className="h-4 w-4" />
          保存
        </Button>
      </div>
    </div>
  );
}
