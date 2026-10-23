"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText, type RateTableView } from "@/lib/deals/client";
import { bpToPercentText, parseYen, percentTextToBp } from "@/lib/deals/money-forms";
import { RATE_TABLE_KIND_LABELS, type RateTableKind } from "@/lib/deals/rate-tables";

type Row = { upTo: string; value: string };
type CgKey = "longIncome" | "longResident" | "shortIncome" | "shortResident" | "reconstruction" | "years" | "deduction" | "unknownCost";

/**
 * 税率・税額の表を1つ直す・足す(設計 §2.5)。中身は種類ごとの入力欄で直し、送る前に数に直す。
 * table.id が空=今の表を写して「期間を足す」(新しく作る)。検証(区分の並び・期間の重なり)はサーバーが行い、理由を出す。
 */
export function RateTableEditor({
  table, kind, onDone, onCancel,
}: { table: RateTableView | null; kind: RateTableKind; onDone: () => void; onCancel: () => void }) {
  const c = (table?.content ?? {}) as Record<string, unknown>;
  const [validFrom, setValidFrom] = useState(table?.validFrom ?? "");
  const [validTo, setValidTo] = useState(table?.validTo ?? "");
  const [rate, setRate] = useState(kind === "consumption_tax" ? bpToPercentText(Number(c.rateBp ?? 1000)) : "");
  const [rows, setRows] = useState<Row[]>(() => {
    const list = (kind === "brokerage_tiers" ? c.tiers : c.brackets) as { upTo: number | null; rateBp?: number; tax?: number }[] | undefined;
    return (list ?? [{ upTo: null }]).map((r) => ({
      upTo: r.upTo === null ? "" : String(r.upTo),
      value: kind === "brokerage_tiers" ? bpToPercentText(r.rateBp ?? 0) : String(r.tax ?? 0),
    }));
  });
  const special = (c.lowCostSpecial ?? { priceLimit: 8000000, feeCap: 300000 }) as { priceLimit: number; feeCap: number };
  const [priceLimit, setPriceLimit] = useState(String(special.priceLimit));
  const [feeCap, setFeeCap] = useState(String(special.feeCap));
  const cg = c as {
    long?: { incomeTaxBp: number; residentTaxBp: number }; short?: { incomeTaxBp: number; residentTaxBp: number };
    reconstructionBp?: number; longTermYears?: number; residentialDeduction?: number; unknownCostRateBp?: number;
  };
  const [cgv, setCgv] = useState<Record<CgKey, string>>({
    longIncome: bpToPercentText(cg.long?.incomeTaxBp ?? 1500), longResident: bpToPercentText(cg.long?.residentTaxBp ?? 500),
    shortIncome: bpToPercentText(cg.short?.incomeTaxBp ?? 3000), shortResident: bpToPercentText(cg.short?.residentTaxBp ?? 900),
    reconstruction: bpToPercentText(cg.reconstructionBp ?? 210), years: String(cg.longTermYears ?? 5),
    deduction: String(cg.residentialDeduction ?? 30000000), unknownCost: bpToPercentText(cg.unknownCostRateBp ?? 500),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 読めない値は null のまま送る=サーバーの検証で 422(VALIDATION_ERROR)になり、下の文言で知らせる。
  const content = (): unknown => {
    const pct = (s: string) => percentTextToBp(s);
    if (kind === "consumption_tax") return { rateBp: pct(rate) };
    if (kind === "capital_gains") {
      return {
        long: { incomeTaxBp: pct(cgv.longIncome), residentTaxBp: pct(cgv.longResident) },
        short: { incomeTaxBp: pct(cgv.shortIncome), residentTaxBp: pct(cgv.shortResident) },
        reconstructionBp: pct(cgv.reconstruction), longTermYears: parseYen(cgv.years),
        residentialDeduction: parseYen(cgv.deduction), unknownCostRateBp: pct(cgv.unknownCost),
      };
    }
    const list = rows.map((r, i) => ({
      upTo: i === rows.length - 1 && r.upTo.trim() === "" ? null : parseYen(r.upTo),
      ...(kind === "brokerage_tiers" ? { rateBp: pct(r.value) } : { tax: parseYen(r.value) }),
    }));
    return kind === "brokerage_tiers"
      ? { tiers: list, lowCostSpecial: { priceLimit: parseYen(priceLimit), feeCap: parseYen(feeCap) } }
      : { brackets: list };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { validFrom, validTo: validTo || null, content: content() };
      if (table?.id) await dealsApi.updateRateTable(table.id, { ...body, updatedAt: table.updatedAt });
      else await dealsApi.createRateTable({ kind, ...body });
      onDone();
    } catch (e) {
      const code = e instanceof DealApiError ? e.code : "";
      setError(
        code === "VERSION_CONFLICT" ? "ほかの人が先に直しました。画面を読み込み直してください。"
        : code === "PERIOD_OVERLAP" ? "同じ種類の表と期間が重なっています。期間を直してください。"
        : code === "VALIDATION_ERROR" ? "入力に誤りがあります。日付・数字・区分の並び(小さい順・最後だけ上限なし)を確かめてください。"
        : errorText(e),
      );
    } finally {
      setSaving(false);
    }
  };

  const cgField = (label: string, k: CgKey) => (
    <Field key={k} label={label}><input inputMode="decimal" value={cgv[k]} onChange={(e) => setCgv((v) => ({ ...v, [k]: e.target.value }))} aria-label={label} className={inputCls} /></Field>
  );

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <p className="text-sm font-semibold">{RATE_TABLE_KIND_LABELS[kind]}{table?.id ? "を直す" : "の期間を足す"}</p>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="適用開始"><input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} aria-label="適用開始" className={inputCls} /></Field>
        <Field label="適用終了" hint="空欄なら期限なし"><input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} aria-label="適用終了" className={inputCls} /></Field>
      </div>
      {kind === "consumption_tax" && (
        <Field label="消費税率(%)"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="消費税率" className={inputCls} /></Field>
      )}
      {kind === "capital_gains" && (
        <div className="grid gap-3 sm:grid-cols-4">
          {cgField("長期 所得税(%)", "longIncome")}
          {cgField("長期 住民税(%)", "longResident")}
          {cgField("短期 所得税(%)", "shortIncome")}
          {cgField("短期 住民税(%)", "shortResident")}
          {cgField("復興特別所得税(所得税に対する%)", "reconstruction")}
          {cgField("取得費が不明のとき(売却価格の%)", "unknownCost")}
          {cgField("長期になる年数(超)", "years")}
          {cgField("居住用の特別控除(円)", "deduction")}
        </div>
      )}
      {(kind === "brokerage_tiers" || kind === "stamp_contract" || kind === "stamp_receipt") && (
        <>
          <p className="text-xs text-gray-500">金額の区分は小さい順に並べ、最後の行の上限は空欄(上限なし)にします。</p>
          <ul className="space-y-2">
            {rows.map((r, i) => (
              <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Field label={i === rows.length - 1 ? "上限(円以下)・空欄=上限なし" : "上限(円以下)"}>
                  <input inputMode="numeric" value={r.upTo} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))} aria-label="上限" className={inputCls} />
                </Field>
                <Field label={kind === "brokerage_tiers" ? "率(%)" : "税額(円)"}>
                  <input inputMode="decimal" value={r.value} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label={kind === "brokerage_tiers" ? "率" : "税額"} className={inputCls} />
                </Field>
                <Button variant="ghost" size="sm" disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" />消す</Button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs.slice(0, -1), { upTo: "", value: "0" }, ...rs.slice(-1)])}>
            <Plus className="h-4 w-4" />
            区分を足す
          </Button>
          {kind === "brokerage_tiers" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="特例の価格の上限(円)"><input inputMode="numeric" value={priceLimit} onChange={(e) => setPriceLimit(e.target.value)} aria-label="特例の価格の上限" className={inputCls} /></Field>
              <Field label="特例の手数料の上限(円・税抜)"><input inputMode="numeric" value={feeCap} onChange={(e) => setFeeCap(e.target.value)} aria-label="特例の手数料の上限" className={inputCls} /></Field>
            </div>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={saving || !validFrom} loading={saving} loadingLabel="保存中"><Save className="h-4 w-4" />保存</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>やめる</Button>
      </div>
    </div>
  );
}
