"use client";

import { useState } from "react";
import { Calculator, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FreeYenField, OverrideField, YenInput, inputCls } from "./form-parts";
import { BROKERAGE_QUICK_OPTIONS, brokerageInclOf, brokerageQuick, type BrokerageQuickMode } from "@/lib/deals/calc/brokerage";
import { stampNote } from "@/lib/deals/calc/stamp";
import { DealPropertySaleTax } from "./deal-property-sale-tax";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { MONEY_OVERRIDE_KEYS, invalidYenLabels, mergeOverrides, parseYen, textify, untextify, yenText } from "@/lib/deals/money-forms";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import type { Costs, Overrides } from "@/lib/deals/schemas";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
const s = (n: number | null) => (n === null ? "" : String(n));
/** 金額・費用(設計 §5)。計算の値は保存したあとの計算結果(サーバー)を出す。 */
export default function DealMoneyPanel({
  deal, calc, onSaved, property = null,
}: {
  deal: DealView;
  calc: DealCalc | null;
  onSaved: () => Promise<void>;
  /** 物件の販売価格と消費税を出すとき(物件を開ける人だけ)。onEdit で横に物件の編集を開く。 */
  property?: { id: string; revision: string; canEdit: boolean; onEdit: () => void } | null;
}) {
  const [price, setPrice] = useState(s(deal.price));
  const [deposit, setDeposit] = useState(s(deal.deposit));
  const [costs, setCosts] = useState<Costs>(deal.costs);
  // その他の費用の金額は入力の文字のまま持つ(打ち間違いを 0 に置き換えない・@codex)。
  const [others, setOthers] = useState(() => deal.costs.others.map((o) => textify(o, ["amount"] as const)));
  const [fees, setFees] = useState({ registrationFee: s(deal.costs.registrationFee), cancellationFee: s(deal.costs.cancellationFee), surveyFee: s(deal.costs.surveyFee) });
  const [overrides, setOverrides] = useState<Overrides>(deal.overrides);
  const [saving, setSaving] = useState(false);
  // 手で直す欄で読めない文字が入っている欄の名前(@codex 2巡目)。1つでもあれば保存しない。
  const [badOverrides, setBadOverrides] = useState<string[]>([]);
  const validity = (label: string) => (ok: boolean) =>
    setBadOverrides((xs) => (ok ? xs.filter((x) => x !== label) : xs.includes(label) ? xs : [...xs, label]));
  const [error, setError] = useState<string | null>(null);
  // 「正規の手数料率で計算する」の計算のしかた(既定=3%＋6万円＋消費税)。
  const [quickMode, setQuickMode] = useState<BrokerageQuickMode>("3pct_60k");
  const setOverride =(key: keyof Overrides, v: number | undefined) =>
    setOverrides((o) => {
      const next = { ...o };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });
  const scr = (k: keyof Costs["scrivener"], v: string) => setCosts((c) => ({ ...c, scrivener: { ...c.scrivener, [k]: v.trim() === "" ? null : v } }));

  const save = async (nextOverrides: Overrides = overrides, bads: string[] = badOverrides) => {
    const taxRateBp = deal.taxRateBp;
    const parsedOthers = others.map((o, i) => untextify(o, ["amount"] as const, () => `その他の費用${i + 1}行目の金額`));
    const bad = [
      ...invalidYenLabels([
        ["売買価格", price], ["手付金", deposit], ["登記費用", fees.registrationFee], ["抹消費用", fees.cancellationFee], ["測量費", fees.surveyFee],
      ]),
      ...parsedOthers.flatMap((p) => p.bad),
      ...bads,
    ];
    if (bad.length > 0) {
      setError(`${bad.join("・")}は数字で入れてください(例 30000000)。保存していません。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await dealsApi.update(deal.id, {
        version: deal.version,
        price: parseYen(price), deposit: parseYen(deposit), taxRateBp,
        costs: {
          ...costs,
          registrationFee: parseYen(fees.registrationFee), cancellationFee: parseYen(fees.cancellationFee), surveyFee: parseYen(fees.surveyFee),
          others: parsedOthers.map((p) => p.value).filter((o) => o.label.trim() !== ""),
        },
        // ほかのタブ(精算)の上書きは、今の保存済みの値を残す(最終レビュー I-2)。
        overrides: mergeOverrides(deal.overrides, nextOverrides, MONEY_OVERRIDE_KEYS),
      });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 選んだ速算(3%＋6万円 / 3%)で今の売買価格から税抜の仲介手数料を出して欄に入れ、保存する(2026-11-04 発注者)。
   * 税込はサーバーの計算(取引の消費税率)で出るので保存まで行う。
   */
  const recalcBrokerage = () => {
    const p = parseYen(price);
    if (p === null) {
      setError("売買価格を入れてください。");
      return;
    }
    const nextOverrides = { ...overrides, brokerageFee: brokerageQuick(p, quickMode) };
    const bads = badOverrides.filter((x) => x !== "仲介手数料");
    setOverrides(nextOverrides);
    setBadOverrides(bads);
    void save(nextOverrides, bads);
  };

  const brokerageIncl = brokerageInclOf(overrides.brokerageFee ?? calc?.brokerage?.computedExcl ?? null, deal.taxRateBp);
  const brokerageUnsaved = overrides.brokerageFee !== deal.overrides.brokerageFee;
  const remaining = calc?.settlement.remaining ?? null;
  const stamp = calc?.contractStamp ?? null;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {calc && calc.missing.length > 0 && (
        <p className="text-xs text-gray-500">計算に足りない項目: {calc.missing.join("・")}</p>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <Field label="売買価格(税込)"><YenInput label="売買価格" value={price} onChange={setPrice} /></Field>
        <Field label="手付金"><YenInput label="手付金" value={deposit} onChange={setDeposit} /></Field>
        {/* 消費税率の欄は出さない(2026-11-04 発注者「いらない」)。保存済みの率(既定 10%)をそのまま使う。 */}
        <p className="text-sm sm:col-span-3">残代金(売買価格−手付金): <b className="tabular-nums">{remaining === null ? "—" : `${yenText(remaining)}円`}</b></p>
      </section>

      {property && (
        <DealPropertySaleTax propertyId={property.id} revision={property.revision} canEdit={property.canEdit} onEdit={property.onEdit} />
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">建物価格と建物消費税(業者売主の場合)</h3>
        <p className="text-xs text-gray-500">評価額は「物件」タブで入れます。契約書で建物価格を決めているときは、手で直してください。</p>
        <OverrideField label="建物価格(税込)" onValidity={validity("建物価格(税込)")} computed={calc?.building.computedPrice ?? null} override={overrides.buildingPrice} onChange={(v) => setOverride("buildingPrice", v)} />
        <OverrideField label="建物消費税" onValidity={validity("建物消費税")} computed={calc?.building.computedTax ?? null} override={overrides.buildingTax} onChange={(v) => setOverride("buildingTax", v)} />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">仲介手数料(税抜)</h3>
        {/* 自由に入れる(2026-11-04 発注者)。空欄のときは上限額で計算する(資金計画表などがこの額を使う)。 */}
        <FreeYenField
          label="仲介手数料"
          onValidity={validity("仲介手数料")}
          value={overrides.brokerageFee}
          onChange={(v) => setOverride("brokerageFee", v)}
          placeholder={calc?.brokerage?.computedExcl != null ? `空欄のときは上限額 ${yenText(calc.brokerage.computedExcl)}円` : ""}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="手数料の計算のしかた" value={quickMode} onChange={(e) => setQuickMode(e.target.value as BrokerageQuickMode)} className={`${inputCls} w-auto`}>
            {BROKERAGE_QUICK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={recalcBrokerage} disabled={saving}>
            <Calculator className="h-4 w-4" />
            正規の手数料率で計算する
          </Button>
          <span className="text-xs text-gray-500">今の売買価格で計算して欄に入れ、このタブの内容を保存します。</span>
        </div>
        {/* 入れた額をその場で税込に出す(保存のあとの計算を待たない・2026-11-04 発注者「手入力が反映されない」)。 */}
        <p className="text-sm">
          税込: <b className="tabular-nums">{brokerageIncl === null ? "—" : `${yenText(brokerageIncl)}円`}</b>
          {brokerageUnsaved && <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">まだ保存していません。下の「保存」で確定します</span>}
        </p>
        {/* 特例は仲介手数料の欄のいちばん下(2026-11-04 発注者)。 */}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={costs.lowCostSpecial} onChange={(e) => setCosts((c) => ({ ...c, lowCostSpecial: e.target.checked }))} />
          低廉な空家等の特例(800万円以下は上限30万円＋税)
        </label>
      </section>


      <p className="text-sm">
        売買契約書の印紙税(1通): <b className="tabular-nums">{stamp === null ? "—" : `${yenText(stamp)}円`}</b>
        {/* 不動産の譲渡に関する契約書の軽減措置(租税特別措置法91条・2026-11-04 国税庁で確認=2027-03-31 作成分まで)。基準日で表を選んでいる。 */}
        {stamp !== null && calc && (
          <span className="ml-2 text-xs text-gray-500">{stampNote(calc.baseDate)}</span>
        )}
      </p>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">司法書士・費用</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="司法書士(名前)"><input value={costs.scrivener.name ?? ""} onChange={(e) => scr("name", e.target.value)} maxLength={100} aria-label="司法書士の名前" className={inputCls} /></Field>
          <Field label="司法書士(担当)"><input value={costs.scrivener.staff ?? ""} onChange={(e) => scr("staff", e.target.value)} maxLength={100} aria-label="司法書士の担当" className={inputCls} /></Field>
          <Field label="司法書士(住所)"><input value={costs.scrivener.address ?? ""} onChange={(e) => scr("address", e.target.value)} maxLength={300} aria-label="司法書士の住所" className={inputCls} /></Field>
          <Field label="司法書士(電話)"><input value={costs.scrivener.tel ?? ""} onChange={(e) => scr("tel", e.target.value)} maxLength={50} aria-label="司法書士の電話" className={inputCls} /></Field>
          <Field label="登記費用"><YenInput label="登記費用" value={fees.registrationFee} onChange={(v) => setFees((f) => ({ ...f, registrationFee: v }))} /></Field>
          <Field label="抹消費用"><YenInput label="抹消費用" value={fees.cancellationFee} onChange={(v) => setFees((f) => ({ ...f, cancellationFee: v }))} /></Field>
          <Field label="測量費"><YenInput label="測量費" value={fees.surveyFee} onChange={(v) => setFees((f) => ({ ...f, surveyFee: v }))} /></Field>
        </div>
        <ul className="space-y-2">
          {others.map((o, i) => (
            <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Field label="その他の費用(名前)">
                <input value={o.label} onChange={(e) => setOthers((os) => os.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={50} aria-label="その他の費用の名前" className={inputCls} />
              </Field>
              <Field label="金額">
                <YenInput label="その他の費用の金額" value={o.amount} onChange={(v) => setOthers((os) => os.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
              </Field>
              <Button variant="ghost" size="sm" onClick={() => setOthers((os) => os.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
                消す
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" disabled={others.length >= 20} onClick={() => setOthers((os) => [...os, { label: "", amount: "" }])}>
          <Plus className="h-4 w-4" />
          その他の費用を足す
        </Button>
      </section>

      <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存
      </Button>
    </div>
  );
}
