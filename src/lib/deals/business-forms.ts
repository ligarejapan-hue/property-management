import { bpToPercentText, invalidYenLabels, parseYen, percentTextToBp } from "./money-forms";
import { businessInputsSchema, type BusinessInputs, type Comparable } from "./business-schema";

/** 画面で持つ形: 金額・率・期間は入力の文字のまま(打ち間違いを 0 や空に置き換えない)。 */
const YEN = [
  "purchaseBrokerage", "outsourcingFee", "registrationFee", "acquisitionTax", "settlementPaid", "interiorCost", "demolitionCost",
  "loanAmount", "salePrice", "saleBuildingTax", "saleBrokerage", "mortgageCancellation", "surveyFee", "ownFunds", "ocAnnualExpenses",
] as const;
type YenKey = (typeof YEN)[number];

export const BUSINESS_YEN_LABELS: Record<YenKey, string> = {
  purchaseBrokerage: "仲介手数料(仕入)", outsourcingFee: "業務委託料", registrationFee: "登記費用", acquisitionTax: "不動産取得税",
  settlementPaid: "精算金", interiorCost: "内装費", demolitionCost: "解体費", loanAmount: "借入額", salePrice: "売却価格",
  saleBuildingTax: "販売の建物消費税", saleBrokerage: "仲介手数料(販売)", mortgageCancellation: "抵当権抹消", surveyFee: "測量",
  ownFunds: "自己資金", ocAnnualExpenses: "年間の運営費",
};

type OtherRow = { label: string; amount: string };
export type ComparableRow = { kind: Comparable["kind"]; name: string; area: string; price: string; period: string; note: string };

export type BusinessForm = Record<YenKey, string> & {
  variant: BusinessInputs["variant"];
  stampShare: BusinessInputs["stampShare"];
  repayment: BusinessInputs["repayment"];
  saleDate: string;
  loanRate: string;
  loanMonths: string;
  acquisitionOthers: OtherRow[];
  saleOthers: OtherRow[];
  comparables: ComparableRow[];
  memo: string;
};

const t = (n: number | null) => (n === null ? "" : String(n));

export function businessFormFromInputs(i: BusinessInputs): BusinessForm {
  return {
    ...(Object.fromEntries(YEN.map((k) => [k, t(i[k])])) as Record<YenKey, string>),
    variant: i.variant, stampShare: i.stampShare, repayment: i.repayment,
    saleDate: i.saleDate ?? "", loanRate: bpToPercentText(i.loanRateBp), loanMonths: t(i.loanMonths),
    acquisitionOthers: i.acquisitionOthers.map((o) => ({ label: o.label, amount: String(o.amount) })),
    saleOthers: i.saleOthers.map((o) => ({ label: o.label, amount: String(o.amount) })),
    comparables: i.comparables.map((c) => ({
      kind: c.kind, name: c.name ?? "", area: c.area === null ? "" : String(c.area), price: t(c.price), period: c.period ?? "", note: c.note ?? "",
    })),
    memo: i.memo ?? "",
  };
}

const intText = (s: string): number | null => {
  const v = s.normalize("NFKC").trim();
  return /^\d+$/.test(v) ? Number(v) : null;
};
const decimalText = (s: string): number | null => {
  const v = s.normalize("NFKC").trim();
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
};

/**
 * 画面の形 → 保存する形。読めない欄があれば value は null で、欄の名前を bad に並べる(保存もプレビューもしない)。
 * 名前も金額も空の行は捨てる。
 */
export function businessInputsFromForm(f: BusinessForm): { value: BusinessInputs | null; bad: string[] } {
  const bad = invalidYenLabels(YEN.map((k) => [BUSINESS_YEN_LABELS[k], f[k]] as [string, string]));
  const loanRateBp = percentTextToBp(f.loanRate.normalize("NFKC"));
  if (loanRateBp === null) bad.push("借入金利");
  const loanMonths = f.loanMonths.trim() === "" ? null : intText(f.loanMonths);
  if (f.loanMonths.trim() !== "" && loanMonths === null) bad.push("借入期間");

  const others = (rows: OtherRow[], name: string) =>
    rows.flatMap((o, i) => {
      const label = o.label.trim();
      if (label === "" && o.amount.trim() === "") return [];
      if (label === "") bad.push(`${name}${i + 1}行目の名前`);
      const amount = parseYen(o.amount);
      if (amount === null) bad.push(`${name}${i + 1}行目の金額`);
      return [{ label, amount: amount ?? 0 }];
    });
  const acquisitionOthers = others(f.acquisitionOthers, "取得経費のその他");
  const saleOthers = others(f.saleOthers, "販売の費用のその他");
  const comparables = f.comparables.flatMap((c, i) => {
    if ([c.name, c.area, c.price, c.period, c.note].every((v) => v.trim() === "")) return [];
    const area = c.area.trim() === "" ? null : decimalText(c.area);
    if (c.area.trim() !== "" && area === null) bad.push(`販売価格の根拠${i + 1}行目の面積`);
    const price = c.price.trim() === "" ? null : parseYen(c.price);
    if (c.price.trim() !== "" && price === null) bad.push(`販売価格の根拠${i + 1}行目の価格`);
    return [{ kind: c.kind, name: c.name, area, price, period: c.period, note: c.note }];
  });
  if (bad.length) return { value: null, bad };

  const r = businessInputsSchema.safeParse({
    ...(Object.fromEntries(YEN.map((k) => [k, parseYen(f[k])])) as Record<YenKey, number | null>),
    variant: f.variant, stampShare: f.stampShare, repayment: f.repayment,
    saleDate: f.saleDate.trim() === "" ? null : f.saleDate.trim(), loanRateBp, loanMonths,
    acquisitionOthers, saleOthers, comparables, memo: f.memo,
  });
  if (r.success) return { value: r.data, bad: [] };
  return { value: null, bad: [...new Set(r.error.issues.map((x) => issueLabel(x.path)))] };
}

function issueLabel(path: PropertyKey[]): string {
  const [a, b] = path.map(String);
  if (a === "saleDate") return "販売予定日";
  if (a === "loanRateBp") return "借入金利(0〜30%)";
  if (a === "loanMonths") return "借入期間(1〜600か月)";
  if (a === "memo") return "社内メモ(1000文字まで)";
  if (a === "comparables") return `販売価格の根拠${Number(b) + 1}行目(物件は100文字・メモは200文字まで)`;
  if (a === "acquisitionOthers" || a === "saleOthers") return "その他の費用(名前は50文字まで・金額は1兆円まで)";
  if (a in BUSINESS_YEN_LABELS) return `${BUSINESS_YEN_LABELS[a as YenKey]}(1兆円まで)`;
  return "入力";
}
