import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, YenInput, inputCls } from "./form-parts";
import { ShareInput } from "./assessments-editor";
import { parseYen, yenText } from "@/lib/deals/money-forms";
import { itemTaxes, type TaxItem } from "@/lib/deals/calc/property-tax";

const MONEY = ["fixedBase", "cityBase", "fixedTax", "cityTax"] as const;
type MoneyKey = (typeof MONEY)[number];
const MONEY_LABELS: Record<MoneyKey, string> = {
  fixedBase: "固定資産税課税標準額", cityBase: "都市計画税課税標準額", fixedTax: "固定資産税の税額", cityTax: "都市計画税の税額",
};
const KIND_LABELS = { land: "土地", building: "建物" } as const;
const MAX_ROWS = 40;

/** 画面で持つ形。金額は打った文字のまま(打ち間違いを 0 に置き換えない)。 */
export type TaxItemForm = Omit<TaxItem, MoneyKey | "label"> & Record<MoneyKey, string> & { label: string };

/** 行の呼び名(土地1・建物2 …)。区分ごとに番号を振る。 */
const namesOf = (rows: { kind: TaxItem["kind"] }[]) => {
  const n = { land: 0, building: 0 };
  return rows.map((r) => `${KIND_LABELS[r.kind]}${++n[r.kind]}`);
};

export function taxItemsToForm(items: TaxItem[]): TaxItemForm[] {
  return items.map((i) => ({
    ...i, label: i.label ?? "",
    ...(Object.fromEntries(MONEY.map((k) => [k, i[k] === null ? "" : String(i[k])])) as Record<MoneyKey, string>),
  }));
}

/** 保存の形に戻す。空は null。読めない欄は bad に「土地1の…」の名前を入れる(1つでもあれば保存しない)。 */
export function taxItemsFromForm(rows: TaxItemForm[]): { value: TaxItem[]; bad: string[] } {
  const names = namesOf(rows);
  const bad: string[] = [];
  const value = rows.map((r, i) => {
    const money = Object.fromEntries(MONEY.map((k) => {
      if (r[k].trim() === "") return [k, null];
      const n = parseYen(r[k]);
      if (n === null) bad.push(`${names[i]}の${MONEY_LABELS[k]}`);
      return [k, n];
    })) as Record<MoneyKey, number | null>;
    if (r.shareNum > r.shareDen) bad.push(`${names[i]}の持分(分子は分母以下にしてください)`);
    return { kind: r.kind, label: r.label.trim() === "" ? null : r.label.trim(), ...money, shareNum: r.shareNum, shareDen: r.shareDen };
  });
  return { value, bad };
}

/**
 * 保存する固都税の入力(@codex #712 2巡目)。使っている入力のしかたの欄だけを検査し、使っていない側は
 * 読めればその値、読めなければ保存済みの値を残す(見えない欄で保存が止まらないように)。
 */
export function resolveTaxInputs(
  mode: "items" | "total",
  form: TaxItemForm[],
  annual: { fixedAssetTax: string; cityPlanningTax: string },
  saved: { taxItems: TaxItem[]; fixedAssetTax: number | null; cityPlanningTax: number | null },
): { taxItems: TaxItem[]; fixedAssetTax: number | null; cityPlanningTax: number | null; bad: string[] } {
  const items = taxItemsFromForm(form);
  const bad: string[] = mode === "items" ? [...items.bad] : [];
  const annualOf = (k: "fixedAssetTax" | "cityPlanningTax", label: string) => {
    const t = annual[k];
    if (t.trim() === "") return null;
    const n = parseYen(t);
    if (n !== null) return n;
    if (mode === "total") bad.push(label);
    return saved[k];
  };
  return {
    taxItems: mode === "items" || items.bad.length === 0 ? items.value : saved.taxItems,
    fixedAssetTax: annualOf("fixedAssetTax", "固定資産税"),
    cityPlanningTax: annualOf("cityPlanningTax", "都市計画税"),
    bad,
  };
}

const emptyRow = (kind: TaxItem["kind"]): TaxItemForm => ({
  kind, label: "", fixedBase: "", cityBase: "", shareNum: 1, shareDen: 1, fixedTax: "", cityTax: "",
});

/**
 * 固都税の土地・建物の行(2026-11-12)。課税標準額と持分から税額を出し、税額の箱が空ならその値を薄く見せる。
 * 税額の箱に入れた値があればそちらを使う(税額が初めから分かっているとき・納税通知書と合わせるとき)。
 */
export function TaxItemsEditor({ value, onChange }: { value: TaxItemForm[]; onChange: (v: TaxItemForm[]) => void }) {
  const names = namesOf(value);
  const setRow = (i: number, patch: Partial<TaxItemForm>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {value.map((r, i) => {
          // 持分の分子が分母より大きいと税額が膨らむので、自動の値を出さない(保存も止める)。
          const shareOk = r.shareNum <= r.shareDen;
          const auto = itemTaxes({
            ...r, label: null, fixedTax: null, cityTax: null,
            fixedBase: shareOk ? parseYen(r.fixedBase) : null, cityBase: shareOk ? parseYen(r.cityBase) : null,
          });
          const name = names[i];
          const money = (k: MoneyKey) => <YenInput label={`${name}の${MONEY_LABELS[k]}`} value={r[k]} onChange={(v) => setRow(i, { [k]: v })} />;
          const tax = (k: "fixedTax" | "cityTax", a: number | null) => (
            <input
              inputMode="numeric" value={r[k]} placeholder={a === null ? "" : yenText(a)}
              onChange={(e) => setRow(i, { [k]: e.target.value })} aria-label={`${name}の${MONEY_LABELS[k]}`} className={inputCls}
            />
          );
          return (
            <li key={i} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold">{name}</span>
                <Button variant="ghost" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" />消す</Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="名前(任意)" hint="地番・家屋番号など">
                  <input value={r.label} maxLength={100} onChange={(e) => setRow(i, { label: e.target.value })} aria-label={`${name}の名前`} className={inputCls} />
                </Field>
                <Field label={MONEY_LABELS.fixedBase}>{money("fixedBase")}</Field>
                <Field label={MONEY_LABELS.cityBase}>{money("cityBase")}</Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="持分(分子)"><ShareInput label={`${name}の持分(分子)`} value={r.shareNum} onCommit={(n) => setRow(i, { shareNum: n })} /></Field>
                  <Field label="持分(分母)"><ShareInput label={`${name}の持分(分母)`} value={r.shareDen} onCommit={(n) => setRow(i, { shareDen: n })} /></Field>
                </div>
                <Field label={MONEY_LABELS.fixedTax} hint="空なら自動">{tax("fixedTax", auto.fixedAuto)}</Field>
                <Field label={MONEY_LABELS.cityTax} hint="空なら自動">{tax("cityTax", auto.cityAuto)}</Field>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={value.length >= MAX_ROWS} onClick={() => onChange([...value, emptyRow("land")])}><Plus className="h-4 w-4" />土地を足す</Button>
        <Button variant="secondary" size="sm" disabled={value.length >= MAX_ROWS} onClick={() => onChange([...value, emptyRow("building")])}><Plus className="h-4 w-4" />建物を足す</Button>
      </div>
    </div>
  );
}
