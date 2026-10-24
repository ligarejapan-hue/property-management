"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, YenInput, inputCls } from "./form-parts";
import { dealsApi, DealApiError, errorText } from "@/lib/deals/client";
import { yenText } from "@/lib/deals/money-forms";
import {
  BUSINESS_YEN_LABELS, businessFormFromInputs, businessInputsFromForm, type BusinessForm, type ComparableRow,
} from "@/lib/deals/business-forms";
import { BUSINESS_VARIANTS, BUSINESS_VARIANT_LABELS, COMPARABLE_KIND_LABELS, REPAYMENT_LABELS } from "@/lib/deals/business-schema";
import type { BusinessPlanCalc } from "@/lib/deals/calc/business-plan";
import type { BusinessSectionKey } from "@/lib/deals/business-sections";
import type { DealView } from "@/lib/deals/view";

const PREVIEW_DELAY_MS = 600;
const MAX_COMPARABLES = 10;
const conflictText = (e: unknown) =>
  e instanceof DealApiError && e.code === "VERSION_CONFLICT"
    ? "ほかの人が先にこの取引を更新しました。画面を読み込み直してから、もう一度入力してください。"
    : errorText(e);
type YenKey = keyof typeof BUSINESS_YEN_LABELS;

/**
 * 事業計画書(設計 §5・依頼書 4.2・買取再販だけ)。左で入力し、右に PDF と同じ HTML のプレビューを出す。
 * 社内用・銀行向けは同じ入力の中の切り替え(切り替えても入力は消えない)。出すセクションは取引の設定の表で決まる。
 */
export default function BusinessPlanForm({ deal, onSaved }: { deal: DealView; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState<BusinessForm>(() => businessFormFromInputs(deal.businessPlan));
  const [preview, setPreview] = useState<{ html: string; calc: BusinessPlanCalc; sections: BusinessSectionKey[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // 保存で返った版の番号。保存のあとの読み直しに失敗しても、次の保存を「ほかの人が更新」にしない。
  const [savedVersion, setSavedVersion] = useState(0);
  const seq = useRef(0);

  const parsed = businessInputsFromForm(form);
  const parsedKey = parsed.value ? JSON.stringify(parsed.value) : null;

  // 入力が読める形のときだけ、少し待ってからプレビューを作り直す(古い応答は捨てる)。
  useEffect(() => {
    if (!parsedKey) return;
    const my = ++seq.current;
    const timer = setTimeout(() => {
      dealsApi.businessPreview(deal.id, JSON.parse(parsedKey)).then(
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

  const set = <K extends keyof BusinessForm>(k: K, v: BusinessForm[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = async () => {
    if (!parsed.value) {
      setError(`${parsed.bad.join("・")}を直してください。保存していません。`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await dealsApi.update(deal.id, { version: Math.max(deal.version, savedVersion), businessPlan: parsed.value });
      setSavedVersion(r.version);
      setSaved(true);
      await onSaved();
    } catch (e) {
      setError(conflictText(e));
    } finally {
      setSaving(false);
    }
  };

  const calc = preview?.calc ?? null;
  // 出すセクション(種別×セクションの表・銀行向け/OC の決まり)の入力欄だけを出す。出さない欄の費用は経費合計にも入らない。
  // プレビューがまだ無いうちは、社内用/銀行向けの決まりだけで決める。
  const shown = (s: BusinessSectionKey) =>
    preview
      ? preview.sections.includes(s)
      : !((s === "financing" || s === "evidence") && form.variant !== "bank") && !(s === "oc" && !deal.hasOc);
  const yen = (k: YenKey, hint?: string) => (
    <Field label={BUSINESS_YEN_LABELS[k]} hint={hint}>
      <YenInput label={BUSINESS_YEN_LABELS[k]} value={form[k]} onChange={(v) => set(k, v)} />
    </Field>
  );
  /** 仲介手数料の上限額を入れるボタン(自動では入れない=計画の読み替え 5)。 */
  const capButton = (k: "purchaseBrokerage" | "saleBrokerage", cap: number | null | undefined) =>
    cap ? (
      <Button variant="ghost" size="sm" onClick={() => set(k, String(cap))}>上限額 {yenText(cap)}円 を入れる</Button>
    ) : null;
  const bank = form.variant === "bank";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
      {/* 保存中は打てなくする(保存のあとの作り直しで、その間の入力が消えないように)。 */}
      <fieldset disabled={saving} className="min-w-0 space-y-6">
        <div role="group" aria-label="社内用・銀行向けの切り替え" className="inline-flex gap-1">
          {BUSINESS_VARIANTS.map((v) => (
            <Button key={v} size="sm" variant={form.variant === v ? "primary" : "secondary"} aria-pressed={form.variant === v} onClick={() => set("variant", v)}>
              {BUSINESS_VARIANT_LABELS[v]}
            </Button>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          {bank ? "銀行向けは承認欄・社内メモを出さず、資金計画と販売価格の根拠を出します。" : "社内用は承認欄(担当・上長・決裁者)と社内メモを出します。"}
          仕入価格・建物消費税・登記費用・精算金は、取引の「金額・費用」「精算」タブの値を使います。出すセクションは、管理者が「取引の設定」の種別×セクションの表で決めます。
        </p>

        {shown("acquisition") && (
        <Group title="取得経費">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>{yen("purchaseBrokerage")}{capButton("purchaseBrokerage", calc?.brokerageCap.purchase)}</div>
            {yen("outsourcingFee")}
            {yen("registrationFee", "空なら取引の登記費用")}
            {yen("acquisitionTax", "手入力")}
            {yen("settlementPaid", "空なら決済の計算(自社が払う分)")}
            <Field label="売買契約書の印紙">
              <select aria-label="売買契約書の印紙" value={form.stampShare} onChange={(e) => set("stampShare", e.target.value as BusinessForm["stampShare"])} className={inputCls}>
                <option value="full">全額</option>
                <option value="half">折半</option>
              </select>
            </Field>
          </div>
          <OtherRows rows={form.acquisitionOthers} onChange={(rows) => set("acquisitionOthers", rows)} />
        </Group>
        )}

        {shown("renovation") && (
          <Group title="改装・工事">
            <div className="grid gap-4 sm:grid-cols-2">{yen("interiorCost")}{yen("demolitionCost")}</div>
          </Group>
        )}

        {/* 借入額は資金計画(銀行向け)でも使うので、保有コストを出さないときも残す(@codex P2)。 */}
        {(shown("holding") || shown("financing")) && (
        <Group title={shown("holding") ? "保有コスト" : "借入"}>
          <div className="grid gap-4 sm:grid-cols-2">
            {shown("holding") && (
              <>
                <Field label="販売予定日" hint="事業期間 = 決済日〜この日">
                  <input type="date" value={form.saleDate} onChange={(e) => set("saleDate", e.target.value)} aria-label="販売予定日" className={inputCls} />
                </Field>
                <Field label="借入金利(年%)">
                  <input inputMode="decimal" value={form.loanRate} onChange={(e) => set("loanRate", e.target.value)} aria-label="借入金利" className={inputCls} />
                </Field>
              </>
            )}
            {yen("loanAmount")}
          </div>
          {shown("holding") && calc && <p className="text-xs text-gray-500">事業期間 {calc.holding.days === null ? "—" : `${calc.holding.days}日`}・保有コスト {yenText(calc.holding.total)}円</p>}
        </Group>
        )}

        {/* 売却価格は収支でも使うので、販売を出さないときも残す(@codex P2)。 */}
        {(shown("sale") || shown("profit")) && (
        <Group title={shown("sale") ? "販売" : "売却価格"}>
          <div className="grid gap-4 sm:grid-cols-2">
            {yen("salePrice", "税込")}
            {shown("sale") && (
              <>
                {yen("saleBuildingTax", "空なら仕入と同じ割合で按分")}
                <div>{yen("saleBrokerage")}{capButton("saleBrokerage", calc?.brokerageCap.sale)}</div>
                {yen("mortgageCancellation")}
                {yen("surveyFee")}
              </>
            )}
          </div>
          {shown("sale") && <OtherRows rows={form.saleOthers} onChange={(rows) => set("saleOthers", rows)} />}
        </Group>
        )}

        {calc && (
          <p className="rounded-md bg-gray-50 px-3 py-2 text-sm dark:bg-gray-900">
            粗利 <b className="tabular-nums">{calc.profit.gross === null ? "—" : `${yenText(calc.profit.gross)}円`}</b>
            ・利益率 <b className="tabular-nums">{calc.profit.marginBp === null ? "—" : `${(calc.profit.marginBp / 100).toFixed(2)}%`}</b>
          </p>
        )}

        {shown("financing") && (
        <Group title="資金計画">
          <div className="grid gap-4 sm:grid-cols-2">
            {yen("ownFunds")}
            <Field label="借入期間(か月)">
              <input inputMode="numeric" value={form.loanMonths} onChange={(e) => set("loanMonths", e.target.value)} aria-label="借入期間" className={inputCls} />
            </Field>
            <Field label="返済方法">
              <select aria-label="返済方法" value={form.repayment} onChange={(e) => set("repayment", e.target.value as BusinessForm["repayment"])} className={inputCls}>
                {Object.entries(REPAYMENT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </div>
        </Group>
        )}

        {shown("oc") && (
          <Group title="OC収支">
            <div className="grid gap-4 sm:grid-cols-2">{yen("ocAnnualExpenses", "空なら固都税+管理費等の年額")}</div>
            <p className="text-xs text-gray-500">賃料は取引の「OC」タブの値を使います。</p>
          </Group>
        )}

        {shown("evidence") && (
        <Group title="販売価格の根拠">
          <Comparables rows={form.comparables} onChange={(rows) => set("comparables", rows)} />
        </Group>
        )}

        <Group title="社内メモ" note={bank ? "社内用にだけ出します" : undefined}>
          <textarea value={form.memo} onChange={(e) => set("memo", e.target.value)} maxLength={1000} rows={3} aria-label="社内メモ" className={inputCls} />
        </Group>

        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        {!error && parsed.bad.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">直す欄: {parsed.bad.join("・")}(直すまでプレビューは前のままです)</p>
        )}
        {saved && !error && <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">事業計画書の入力を保存しました</p>}
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
          <iframe title="事業計画書のプレビュー" srcDoc={preview.html} sandbox="" className="h-[1400px] w-full rounded border border-gray-200 bg-white dark:border-gray-700" />
        ) : (
          <p className="text-sm text-gray-500">プレビューを作っています…</p>
        )}
      </div>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
        {title}
        {note && <span className="ml-2 text-xs font-normal text-gray-500">{note}</span>}
      </h3>
      {children}
    </section>
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

function Comparables({ rows, onChange }: { rows: ComparableRow[]; onChange: (rows: ComparableRow[]) => void }) {
  const patch = (i: number, p: Partial<ComparableRow>) => onChange(rows.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <>
      <ul className="space-y-3">
        {rows.map((r, i) => (
          <li key={i} className="grid items-end gap-2 rounded-md border border-gray-200 p-2 sm:grid-cols-3 dark:border-gray-800">
            <Field label="区分">
              <select aria-label="事例の区分" value={r.kind} onChange={(e) => patch(i, { kind: e.target.value as ComparableRow["kind"] })} className={inputCls}>
                {Object.entries(COMPARABLE_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="物件"><input value={r.name} onChange={(e) => patch(i, { name: e.target.value })} maxLength={100} aria-label="事例の物件" className={inputCls} /></Field>
            <Field label="面積(㎡)"><input inputMode="decimal" value={r.area} onChange={(e) => patch(i, { area: e.target.value })} aria-label="事例の面積" className={inputCls} /></Field>
            <Field label="価格"><YenInput label="事例の価格" value={r.price} onChange={(v) => patch(i, { price: v })} /></Field>
            <Field label="時期"><input value={r.period} onChange={(e) => patch(i, { period: e.target.value })} maxLength={30} aria-label="事例の時期" className={inputCls} /></Field>
            <Field label="メモ"><input value={r.note} onChange={(e) => patch(i, { note: e.target.value })} maxLength={200} aria-label="事例のメモ" className={inputCls} /></Field>
            <Button variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
              消す
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="sm" disabled={rows.length >= MAX_COMPARABLES} onClick={() => onChange([...rows, { kind: "sold", name: "", area: "", price: "", period: "", note: "" }])}>
        <Plus className="h-4 w-4" />
        事例を足す
      </Button>
    </>
  );
}
