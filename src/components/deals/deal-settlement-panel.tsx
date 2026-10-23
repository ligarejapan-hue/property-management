"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, OverrideField, SelectBox, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { SETTLEMENT_OVERRIDE_KEYS, invalidYenLabels, mergeOverrides, parseYen, textify, untextify, yenText } from "@/lib/deals/money-forms";
import type { DealView } from "@/lib/deals/view";
import type { DealCalc } from "@/lib/deals/calc/deal-calc";
import type { Overrides, SettlementTerms } from "@/lib/deals/schemas";

const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先に更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
const s = (n: number | null) => (n === null ? "" : String(n));
const MONEY_KEYS = ["fixedAssetTax", "cityPlanningTax", "managementFee", "repairReserve", "otherMonthly"] as const;
const OTHER_KEYS = ["sellerToBuyer", "buyerToSeller"] as const;
const MONEY_LABELS: Record<(typeof MONEY_KEYS)[number], string> = {
  fixedAssetTax: "固定資産税", cityPlanningTax: "都市計画税", managementFee: "管理費", repairReserve: "修繕積立金", otherMonthly: "その他の月額",
};
type MoneyKey = (typeof MONEY_KEYS)[number];

/** 精算(依頼書 3.2・4.4)。条件を入れて保存すると、サーバーの決済の計算の結果を表で出す。 */
export default function DealSettlementPanel({ deal, calc, onSaved }: { deal: DealView; calc: DealCalc | null; onSaved: () => Promise<void> }) {
  const [terms, setTerms] = useState<SettlementTerms>(deal.settlementTerms);
  // その他の精算の金額は入力の文字のまま持つ(打ち間違いを 0 に置き換えない・@codex)。
  const [others, setOthers] = useState(() => deal.settlementTerms.others.map((o) => textify(o, OTHER_KEYS)));
  const [money, setMoney] = useState<Record<MoneyKey, string>>(
    Object.fromEntries(MONEY_KEYS.map((k) => [k, s(deal.settlementTerms[k])])) as Record<MoneyKey, string>,
  );
  const [overrides, setOverrides] = useState<Overrides>(deal.overrides);
  const [saving, setSaving] = useState(false);
  // 手で直す欄で読めない文字が入っている欄の名前(@codex 2巡目)。1つでもあれば保存しない。
  const [badOverrides, setBadOverrides] = useState<string[]>([]);
  const validity = (label: string) => (ok: boolean) =>
    setBadOverrides((xs) => (ok ? xs.filter((x) => x !== label) : xs.includes(label) ? xs : [...xs, label]));
  const [error, setError] = useState<string | null>(null);
  const kindBase = calc?.kindBase ?? null;
  const st = calc?.settlement ?? null;
  const setOverride = (key: keyof Overrides, v: number | undefined) =>
    setOverrides((o) => {
      const next = { ...o };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });

  const save = async () => {
    const parsedOthers = others.map((o, i) => untextify(o, OTHER_KEYS, (k) => `その他の精算${i + 1}行目の${k === "sellerToBuyer" ? "売主→買主" : "買主→売主"}`));
    const bad = [...invalidYenLabels(MONEY_KEYS.map((k) => [MONEY_LABELS[k], money[k]])), ...parsedOthers.flatMap((p) => p.bad), ...badOverrides];
    if (bad.length > 0) {
      setError(`${bad.join("・")}は数字で入れてください(例 120000)。保存していません。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next: SettlementTerms = {
        ...terms,
        // 敷金の扱いは OC タブのもの。今の保存済みの値を使う(最終レビュー I-2)。
        depositMode: deal.settlementTerms.depositMode,
        ...(Object.fromEntries(MONEY_KEYS.map((k) => [k, parseYen(money[k])])) as Record<MoneyKey, number | null>),
        others: parsedOthers.map((p) => p.value).filter((o) => o.label.trim() !== ""),
      };
      await dealsApi.update(deal.id, {
        version: deal.version, settlementTerms: next,
        // ほかのタブ(金額・費用)の上書きは、今の保存済みの値を残す(最終レビュー I-2)。
        overrides: mergeOverrides(deal.overrides, overrides, SETTLEMENT_OVERRIDE_KEYS),
      });
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  const months = (label: string, value: number, onChange: (n: number) => void) => (
    <Field label={label}>
      <SelectBox label={label} value={String(value)} onChange={(v) => onChange(Number(v))} options={Array.from({ length: 13 }, (_, i) => ({ value: String(i), label: `${i}か月` }))} />
    </Field>
  );

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">固定資産税・都市計画税</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="固定資産税(年税額)"><YenInput label="固定資産税" value={money.fixedAssetTax} onChange={(v) => setMoney((m) => ({ ...m, fixedAssetTax: v }))} /></Field>
          <Field label="都市計画税(年税額)"><YenInput label="都市計画税" value={money.cityPlanningTax} onChange={(v) => setMoney((m) => ({ ...m, cityPlanningTax: v }))} /></Field>
          <Field label="起算日">
            <SelectBox label="起算日" value={terms.taxStart} onChange={(v) => setTerms((t) => ({ ...t, taxStart: v as SettlementTerms["taxStart"] }))} options={[{ value: "01-01", label: "1月1日" }, { value: "04-01", label: "4月1日" }]} />
          </Field>
        </div>
      </section>

      {kindBase === "unit" && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">管理費等(月額)</h3>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="管理費"><YenInput label="管理費" value={money.managementFee} onChange={(v) => setMoney((m) => ({ ...m, managementFee: v }))} /></Field>
            <Field label="修繕積立金"><YenInput label="修繕積立金" value={money.repairReserve} onChange={(v) => setMoney((m) => ({ ...m, repairReserve: v }))} /></Field>
            <Field label="その他(月額)"><YenInput label="その他の月額" value={money.otherMonthly} onChange={(v) => setMoney((m) => ({ ...m, otherMonthly: v }))} /></Field>
            {months("前払い月数", terms.managementPrepaidMonths, (n) => setTerms((t) => ({ ...t, managementPrepaidMonths: n })))}
          </div>
        </section>
      )}

      {deal.hasOc && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">賃料(OC)</h3>
          <p className="text-xs text-gray-500">部屋ごとの賃料は「OC」タブで入れます。</p>
          <div className="grid gap-4 sm:grid-cols-3">{months("前受け済みの月数", terms.rentPrepaidMonths, (n) => setTerms((t) => ({ ...t, rentPrepaidMonths: n })))}</div>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">その他の精算(測量費の負担分など)</h3>
        <ul className="space-y-2">
          {others.map((o, i) => (
            <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Field label="項目"><input value={o.label} onChange={(e) => setOthers((os) => os.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={50} aria-label="精算の項目" className={inputCls} /></Field>
              <Field label="売主→買主"><YenInput label="売主→買主" value={o.sellerToBuyer} onChange={(v) => setOthers((os) => os.map((x, j) => (j === i ? { ...x, sellerToBuyer: v } : x)))} /></Field>
              <Field label="買主→売主"><YenInput label="買主→売主" value={o.buyerToSeller} onChange={(v) => setOthers((os) => os.map((x, j) => (j === i ? { ...x, buyerToSeller: v } : x)))} /></Field>
              <Button variant="ghost" size="sm" onClick={() => setOthers((os) => os.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" />消す</Button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" size="sm" disabled={others.length >= 20} onClick={() => setOthers((os) => [...os, { label: "", sellerToBuyer: "", buyerToSeller: "" }])}>
          <Plus className="h-4 w-4" />
          精算の行を足す
        </Button>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">手で直す(計算の値を変えるときだけ)</h3>
        <OverrideField label="固都税(買主→売主)" onValidity={validity("固都税(買主→売主)")} computed={st?.rows.find((r) => r.key === "propertyTax")?.computed ?? null} override={overrides["settlement.propertyTax"]} onChange={(v) => setOverride("settlement.propertyTax", v)} />
        {kindBase === "unit" && (
          <OverrideField label="管理費等(買主→売主)" onValidity={validity("管理費等(買主→売主)")} computed={st?.rows.find((r) => r.key === "management")?.computed ?? null} override={overrides["settlement.management"]} onChange={(v) => setOverride("settlement.management", v)} />
        )}
        {deal.hasOc && (
          <OverrideField label="賃料等(売主→買主)" onValidity={validity("賃料等(売主→買主)")} computed={st?.rows.find((r) => r.key === "rent")?.computed ?? null} override={overrides["settlement.rent"]} onChange={(v) => setOverride("settlement.rent", v)} />
        )}
      </section>

      <Button onClick={() => void save()} disabled={saving} loading={saving} loadingLabel="保存中">
        <Save className="h-4 w-4" />
        保存して計算する
      </Button>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">決済の計算(保存した内容で計算)</h3>
        {!st ? (
          <p className="text-sm text-gray-500">計算を読み込んでいます…</p>
        ) : !st.ready ? (
          <p className="text-sm text-gray-500">{st.missing.join("・")}を入れてください(「基本」タブ)。</p>
        ) : (
          <>
            {st.warnings.map((w) => <p key={w} className="text-sm text-amber-700 dark:text-amber-300">{w}</p>)}
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                  <tr><th className="px-3 py-2">項目</th><th className="px-3 py-2">計算期間</th><th className="px-3 py-2">計算式</th><th className="px-3 py-2 text-right">売主→買主</th><th className="px-3 py-2 text-right">買主→売主</th></tr>
                </thead>
                <tbody>
                  {[...st.rows, ...(st.depositRow ? [st.depositRow] : [])].map((r) => (
                    <tr key={r.key} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-3 py-2">{r.label}{r.overridden && <span className="ml-1 text-xs text-amber-700">(手で直した値)</span>}{r.note && <span className="ml-1 text-xs text-gray-500">({r.note})</span>}</td>
                      <td className="px-3 py-2 tabular-nums">{r.period ?? ""}</td>
                      <td className="px-3 py-2 tabular-nums">{r.formula ?? ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.sellerToBuyer ? yenText(r.sellerToBuyer) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.buyerToSeller ? yenText(r.buyerToSeller) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm font-semibold">{st.netLine}</p>
            {st.remaining !== null && st.paymentAtSettlement !== null && (
              <p className="text-sm tabular-nums">
                残代金 {yenText(st.remaining)}円 ＋ 精算金 {st.net.direction === "sellerToBuyer" ? "−" : ""}{yenText(st.net.amount)}円
                {st.depositOffset > 0 && <> − 敷金承継 {yenText(st.depositOffset)}円</>} ＝ 決済時のお支払額 <b>{yenText(st.paymentAtSettlement)}円</b>
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
