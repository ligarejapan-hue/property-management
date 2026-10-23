"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { yenText } from "@/lib/deals/money-forms";
import {
  PURCHASE_YEN_LABELS, SALE_YEN_LABELS, fundingFormFromInputs, fundingInputsFromForm, type FundingForm,
} from "@/lib/deals/funding-forms";
import type { FundingPlanCalc } from "@/lib/deals/calc/funding-plan";
import type { BasePropertyKind } from "@/lib/deals/constants";
import type { DealView } from "@/lib/deals/view";

const MAX_LOANS = 3;
const PREVIEW_DELAY_MS = 600;
const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先にこの取引を更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);

type Purchase = FundingForm["purchase"];
type Sale = FundingForm["sale"];

/**
 * 資金計画表(設計 §5)。左で入力し、右に PDF と同じ HTML のプレビューを出す。
 * 購入・売却は同じ入力の中の切り替えで、切り替えてももう一方の入力とお客様名は消えない(両方を保存する)。
 */
export default function FundingPlanForm({ deal, kindBase, onSaved }: {
  deal: DealView; kindBase: BasePropertyKind | null; onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<FundingForm>(() => fundingFormFromInputs(deal.fundingPlan));
  const [preview, setPreview] = useState<{ html: string; calc: FundingPlanCalc } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存で返った版の番号。保存のあとの読み直しに失敗しても、次の保存を「ほかの人が更新」にしない(最終レビュー)。
  const [savedVersion, setSavedVersion] = useState(0);
  const seq = useRef(0);

  const parsed = fundingInputsFromForm(form);
  const parsedKey = parsed.value ? JSON.stringify(parsed.value) : null;

  // 入力が読める形のときだけ、少し待ってからプレビューを作り直す(古い応答は捨てる)。
  useEffect(() => {
    if (!parsedKey) return;
    const my = ++seq.current;
    const timer = setTimeout(() => {
      dealsApi.fundingPreview(deal.id, JSON.parse(parsedKey)).then(
        (r) => {
          if (my !== seq.current) return;
          setPreview(r);
          setPreviewError(null);
        },
        (e) => {
          if (my !== seq.current) return;
          setPreviewError(`プレビューを作れませんでした: ${errorText(e)}`);
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [deal.id, parsedKey]);

  const setP = <K extends keyof Purchase>(k: K, v: Purchase[K]) => setForm((f) => ({ ...f, purchase: { ...f.purchase, [k]: v } }));
  const setS = <K extends keyof Sale>(k: K, v: Sale[K]) => setForm((f) => ({ ...f, sale: { ...f.sale, [k]: v } }));

  const save = async () => {
    if (!parsed.value) {
      setError(`${parsed.bad.join("・")}を直してください。保存していません。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await dealsApi.update(deal.id, { version: Math.max(deal.version, savedVersion), fundingPlan: parsed.value });
      setSavedVersion(r.version);
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  const purchase = form.mode === "purchase";
  const building = kindBase !== "land";
  const yenField = (label: string, value: string, onChange: (v: string) => void, hint?: string) => (
    <Field label={label} hint={hint}><YenInput label={label} value={value} onChange={onChange} /></Field>
  );
  const calc = preview?.calc ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {/* 保存中は打てなくする(保存のあとの作り直しで、その間の入力が消えないように)。 */}
      <fieldset disabled={saving} className="min-w-0 space-y-6">
        <div role="group" aria-label="購入・売却の切り替え" className="inline-flex gap-1">
          {(["purchase", "sale"] as const).map((m) => (
            <Button key={m} size="sm" variant={form.mode === m ? "primary" : "secondary"} aria-pressed={form.mode === m} onClick={() => setForm((f) => ({ ...f, mode: m }))}>
              {m === "purchase" ? "購入" : "売却"}
            </Button>
          ))}
        </div>

        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="お客様名">
            <input value={form.customerName} onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))} maxLength={100} aria-label="お客様名" className={inputCls} />
          </Field>
          <Field label="売買契約書の印紙">
            <select aria-label="売買契約書の印紙" value={form.stampShare} onChange={(e) => setForm((f) => ({ ...f, stampShare: e.target.value as FundingForm["stampShare"] }))} className={inputCls}>
              <option value="full">全額</option>
              <option value="half">折半</option>
            </select>
          </Field>
          <p className="text-xs text-gray-500 sm:col-span-2">
            物件価格・仲介手数料・精算金は、取引の「金額・費用」「精算」タブの値を使います。
            <a href={`/deals/${deal.id}`} className="ml-1 text-blue-600 underline dark:text-blue-400">取引の画面へ</a>
          </p>
        </section>

        {purchase ? (
          <>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">諸費用</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {yenField(PURCHASE_YEN_LABELS.registrationTransfer, form.purchase.registrationTransfer, (v) => setP("registrationTransfer", v), "空なら取引の登記費用")}
                {building && yenField(PURCHASE_YEN_LABELS.registrationPreservation, form.purchase.registrationPreservation, (v) => setP("registrationPreservation", v))}
                {yenField(PURCHASE_YEN_LABELS.registrationMortgage, form.purchase.registrationMortgage, (v) => setP("registrationMortgage", v))}
                {yenField(PURCHASE_YEN_LABELS.scrivenerFee, form.purchase.scrivenerFee, (v) => setP("scrivenerFee", v))}
                <Field label="ローン事務手数料の決め方">
                  <select aria-label="ローン事務手数料の決め方" value={form.purchase.loanFeeType} onChange={(e) => setP("loanFeeType", e.target.value as Purchase["loanFeeType"])} className={inputCls}>
                    <option value="fixed">定額</option>
                    <option value="rate">定率(借入額×率)</option>
                  </select>
                </Field>
                {form.purchase.loanFeeType === "fixed"
                  ? yenField(PURCHASE_YEN_LABELS.loanFeeFixed, form.purchase.loanFeeFixed, (v) => setP("loanFeeFixed", v))
                  : (
                    <Field label="事務手数料の率(%)">
                      <input inputMode="decimal" value={form.purchase.loanFeeRate} onChange={(e) => setP("loanFeeRate", e.target.value)} aria-label="事務手数料の率" className={inputCls} />
                    </Field>
                  )}
                {yenField(PURCHASE_YEN_LABELS.loanGuarantee, form.purchase.loanGuarantee, (v) => setP("loanGuarantee", v))}
                {building && yenField(PURCHASE_YEN_LABELS.fireInsurance, form.purchase.fireInsurance, (v) => setP("fireInsurance", v))}
                {yenField(PURCHASE_YEN_LABELS.acquisitionTax, form.purchase.acquisitionTax, (v) => setP("acquisitionTax", v), "手入力")}
              </div>
              <OtherRows rows={form.purchase.others} onChange={(rows) => setP("others", rows)} />
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">資金</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {yenField(PURCHASE_YEN_LABELS.ownFunds, form.purchase.ownFunds, (v) => setP("ownFunds", v))}
                {yenField(PURCHASE_YEN_LABELS.loanAmount, form.purchase.loanAmount, (v) => setP("loanAmount", v), "空なら自動")}
              </div>
              <p className="text-xs text-gray-500">借入額が空のときは「必要な資金の合計−自己資金」、自己資金も空なら物件価格を借りる計算にします。</p>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">ローンの比較(最大{MAX_LOANS}つ)</h3>
              <ul className="space-y-2">
                {form.purchase.loans.map((l, i) => (
                  <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Field label={`パターン${i + 1} 金利(年%)`}>
                      <input inputMode="decimal" value={l.rate} onChange={(e) => setP("loans", form.purchase.loans.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} aria-label={`パターン${i + 1}の金利`} className={inputCls} />
                    </Field>
                    <Field label="期間(年)">
                      <input inputMode="numeric" value={l.years} onChange={(e) => setP("loans", form.purchase.loans.map((x, j) => (j === i ? { ...x, years: e.target.value } : x)))} aria-label={`パターン${i + 1}の年数`} className={inputCls} />
                    </Field>
                    <Button variant="ghost" size="sm" onClick={() => setP("loans", form.purchase.loans.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                      消す
                    </Button>
                  </li>
                ))}
              </ul>
              {form.purchase.loans.length < MAX_LOANS && (
                <Button variant="secondary" size="sm" onClick={() => setP("loans", [...form.purchase.loans, { rate: "", years: "35" }])}>
                  <Plus className="h-4 w-4" />
                  パターンを足す
                </Button>
              )}
              {calc && calc.purchase.loans.length > 0 && (
                <p className="text-sm">
                  月々の返済額: {calc.purchase.loans.map((l, i) => <b key={i} className="mr-3 tabular-nums">{`パターン${i + 1} ${yenText(l.monthly)}円`}</b>)}
                </p>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">費用・残債</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {yenField(SALE_YEN_LABELS.mortgageCancellation, form.sale.mortgageCancellation, (v) => setS("mortgageCancellation", v), "空なら取引の抹消費用")}
                {yenField(SALE_YEN_LABELS.surveyFee, form.sale.surveyFee, (v) => setS("surveyFee", v), "空なら取引の測量費")}
                {kindBase !== "unit" && yenField(SALE_YEN_LABELS.demolitionFee, form.sale.demolitionFee, (v) => setS("demolitionFee", v))}
                {yenField(SALE_YEN_LABELS.loanBalance, form.sale.loanBalance, (v) => setS("loanBalance", v))}
              </div>
              <OtherRows rows={form.sale.others} onChange={(rows) => setS("others", rows)} />
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">譲渡所得税の目安</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="取得日">
                  <input type="date" value={form.sale.acquiredOn} onChange={(e) => setS("acquiredOn", e.target.value)} aria-label="取得日" className={inputCls} />
                </Field>
                {yenField(SALE_YEN_LABELS.acquisitionCost, form.sale.acquisitionCost, (v) => setS("acquisitionCost", v), "空なら売却価格の5%")}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.sale.residentialDeduction} onChange={(e) => setS("residentialDeduction", e.target.checked)} />
                居住用の3,000万円特別控除を使う
              </label>
              <p className="text-xs text-gray-500">概算です。正確な税額は税理士にご確認ください。</p>
            </section>
          </>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        {!error && parsed.bad.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">直す欄: {parsed.bad.join("・")}(直すまでプレビューは前のままです)</p>
        )}
        <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
          <Save className="h-4 w-4" />
          保存
        </Button>
      </fieldset>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">プレビュー</h3>
        {previewError && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{previewError}</p>}
        {calc && calc.missing.length > 0 && <p className="text-xs text-gray-500">足りない項目: {calc.missing.join("・")}</p>}
        {preview ? (
          // スクリプトは動かさない(sandbox に何も許さない)。差し込む値はサーバーで無害化済み。
          <iframe title="資金計画表のプレビュー" srcDoc={preview.html} sandbox="" className="h-[1150px] w-full rounded border border-gray-200 bg-white dark:border-gray-700" />
        ) : (
          <p className="text-sm text-gray-500">プレビューを作っています…</p>
        )}
      </div>
    </div>
  );
}

function OtherRows({ rows, onChange }: { rows: { label: string; amount: string }[]; onChange: (rows: { label: string; amount: string }[]) => void }) {
  return (
    <>
      <ul className="space-y-2">
        {rows.map((o, i) => (
          <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="その他(名前)">
              <input value={o.label} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={50} aria-label="その他の名前" className={inputCls} />
            </Field>
            <Field label="金額">
              <YenInput label="その他の金額" value={o.amount} onChange={(v) => onChange(rows.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
            </Field>
            <Button variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
              消す
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="sm" disabled={rows.length >= 10} onClick={() => onChange([...rows, { label: "", amount: "" }])}>
        <Plus className="h-4 w-4" />
        その他を足す
      </Button>
    </>
  );
}
