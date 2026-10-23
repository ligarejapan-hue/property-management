import { bpToPercentText, invalidYenLabels, parseYen, percentTextToBp } from "./money-forms";
import { fundingInputsSchema, type FundingInputs } from "./funding-schema";

/** 画面で持つ形: 金額・率・年数は入力の文字のまま(打ち間違いを 0 や空に置き換えない)。 */
const PURCHASE_YEN = [
  "registrationTransfer", "registrationPreservation", "registrationMortgage", "scrivenerFee", "loanFeeFixed",
  "loanGuarantee", "fireInsurance", "acquisitionTax", "ownFunds", "loanAmount",
] as const;
const SALE_YEN = ["mortgageCancellation", "surveyFee", "demolitionFee", "loanBalance", "acquisitionCost"] as const;

export const PURCHASE_YEN_LABELS: Record<(typeof PURCHASE_YEN)[number], string> = {
  registrationTransfer: "登記費用(所有権移転)", registrationPreservation: "登記費用(保存)", registrationMortgage: "登記費用(抵当権設定)",
  scrivenerFee: "司法書士報酬", loanFeeFixed: "ローン事務手数料", loanGuarantee: "ローン保証料", fireInsurance: "火災保険",
  acquisitionTax: "不動産取得税(目安)", ownFunds: "自己資金", loanAmount: "借入額",
};
export const SALE_YEN_LABELS: Record<(typeof SALE_YEN)[number], string> = {
  mortgageCancellation: "抵当権抹消費用", surveyFee: "測量費", demolitionFee: "解体費", loanBalance: "ローン残債", acquisitionCost: "取得費",
};

export interface FundingForm {
  mode: FundingInputs["mode"];
  customerName: string;
  stampShare: FundingInputs["stampShare"];
  purchase: Record<(typeof PURCHASE_YEN)[number], string> & {
    loanFeeType: FundingInputs["purchase"]["loanFeeType"];
    loanFeeRate: string;
    others: { label: string; amount: string }[];
    loans: { rate: string; years: string }[];
  };
  sale: Record<(typeof SALE_YEN)[number], string> & {
    others: { label: string; amount: string }[];
    acquiredOn: string;
    residentialDeduction: boolean;
  };
}

const t = (n: number | null) => (n === null ? "" : String(n));
const pick = <K extends string>(src: Record<K, number | null>, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, t(src[k])])) as Record<K, string>;

export function fundingFormFromInputs(i: FundingInputs): FundingForm {
  return {
    mode: i.mode,
    customerName: i.customerName ?? "",
    stampShare: i.stampShare,
    purchase: {
      ...pick(i.purchase, PURCHASE_YEN),
      loanFeeType: i.purchase.loanFeeType,
      loanFeeRate: i.purchase.loanFeeRateBp === null ? "" : bpToPercentText(i.purchase.loanFeeRateBp),
      others: i.purchase.others.map((o) => ({ label: o.label, amount: String(o.amount) })),
      loans: i.purchase.loans.map((l) => ({ rate: bpToPercentText(l.annualRateBp), years: String(l.years) })),
    },
    sale: {
      ...pick(i.sale, SALE_YEN),
      others: i.sale.others.map((o) => ({ label: o.label, amount: String(o.amount) })),
      acquiredOn: i.sale.acquiredOn ?? "",
      residentialDeduction: i.sale.residentialDeduction,
    },
  };
}

const intText = (s: string): number | null => {
  const v = s.normalize("NFKC").trim();
  return /^\d+$/.test(v) ? Number(v) : null;
};

/**
 * 画面の形 → 保存する形。読めない欄があれば value は null で、欄の名前を bad に並べる(保存もプレビューもしない)。
 * 名前が空のその他の行は捨てる。
 */
export function fundingInputsFromForm(f: FundingForm): { value: FundingInputs | null; bad: string[] } {
  const p = f.purchase;
  const s = f.sale;
  const bad = [
    ...invalidYenLabels(PURCHASE_YEN.map((k) => [PURCHASE_YEN_LABELS[k], p[k]] as [string, string])),
    ...invalidYenLabels(SALE_YEN.map((k) => [SALE_YEN_LABELS[k], s[k]] as [string, string])),
  ];
  const loanFeeRateBp = p.loanFeeRate.trim() === "" ? null : percentTextToBp(p.loanFeeRate.normalize("NFKC"));
  if (p.loanFeeRate.trim() !== "" && loanFeeRateBp === null) bad.push("事務手数料の率");
  const others = (rows: { label: string; amount: string }[], name: string) =>
    rows.filter((o) => o.label.trim() !== "").map((o, i) => {
      const amount = parseYen(o.amount);
      if (amount === null) bad.push(`${name}${i + 1}行目の金額`);
      return { label: o.label.trim(), amount: amount ?? 0 };
    });
  const pOthers = others(p.others, "購入のその他の費用");
  const sOthers = others(s.others, "売却のその他の費用");
  const loans = p.loans.map((l, i) => {
    const annualRateBp = percentTextToBp(l.rate.normalize("NFKC"));
    const years = intText(l.years);
    if (annualRateBp === null) bad.push(`パターン${i + 1}の金利`);
    if (years === null) bad.push(`パターン${i + 1}の年数`);
    return { annualRateBp: annualRateBp ?? 0, years: years ?? 0 };
  });
  if (bad.length) return { value: null, bad };

  const yenOf = <K extends string>(src: Record<K, string>, keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, parseYen(src[k])])) as Record<K, number | null>;
  const r = fundingInputsSchema.safeParse({
    mode: f.mode,
    customerName: f.customerName,
    stampShare: f.stampShare,
    purchase: { ...yenOf(p, PURCHASE_YEN), loanFeeType: p.loanFeeType, loanFeeRateBp, others: pOthers, loans },
    sale: {
      ...yenOf(s, SALE_YEN), others: sOthers, acquiredOn: s.acquiredOn.trim() === "" ? null : s.acquiredOn.trim(),
      residentialDeduction: s.residentialDeduction,
    },
  });
  if (r.success) return { value: r.data, bad: [] };
  // 範囲の外(金利 30% 超・年数 50 年超・日付の誤り・長すぎる名前など)は、欄の場所を平易に出す。
  return { value: null, bad: [...new Set(r.error.issues.map((x) => issueLabel(x.path)))] };
}

function issueLabel(path: PropertyKey[]): string {
  const [a, b, c, d] = path.map(String);
  if (a === "customerName") return "お客様名(100文字まで)";
  if (b === "loans") return d === "years" ? `パターン${Number(c) + 1}の年数(1〜50年)` : `パターン${Number(c) + 1}の金利(0〜30%)`;
  if (b === "acquiredOn") return "取得日";
  if (b === "loanFeeRateBp") return "事務手数料の率";
  if (b === "others") return "その他の費用(名前は50文字まで)";
  return "入力";
}
