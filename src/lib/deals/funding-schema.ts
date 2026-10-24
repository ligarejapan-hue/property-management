import { z } from "zod";
import { isoDate, otherCostSchema, text, yenInt } from "./schema-parts";

const bp = z.number().int().min(0).max(10000);

export const fundingLoanSchema = z.object({
  /** 年利(1/100 %)。0〜30%。 */
  annualRateBp: z.number().int().min(0).max(3000),
  years: z.number().int().min(1).max(50),
}).strict();
export type FundingLoan = z.output<typeof fundingLoanSchema>;

export const fundingPurchaseSchema = z.object({
  /** 所有権移転登記。空なら取引の「登記費用」を使う。 */
  registrationTransfer: yenInt.nullable(),
  /** 保存登記(土地は出さない)。 */
  registrationPreservation: yenInt.nullable(),
  registrationMortgage: yenInt.nullable(),
  scrivenerFee: yenInt.nullable(),
  loanFeeType: z.enum(["fixed", "rate"]),
  loanFeeFixed: yenInt.nullable(),
  loanFeeRateBp: bp.nullable(),
  loanGuarantee: yenInt.nullable(),
  /** 火災保険(土地は出さない)。 */
  fireInsurance: yenInt.nullable(),
  /** 不動産取得税の目安。自動では見積もらない(設計 §1)。 */
  acquisitionTax: yenInt.nullable(),
  others: z.array(otherCostSchema).max(10),
  ownFunds: yenInt.nullable(),
  loanAmount: yenInt.nullable(),
  loans: z.array(fundingLoanSchema).max(3),
}).strict();
export type FundingPurchaseInputs = z.output<typeof fundingPurchaseSchema>;

export const fundingSaleSchema = z.object({
  /** 抵当権抹消。空なら取引の「抹消費用」を使う。 */
  mortgageCancellation: yenInt.nullable(),
  /** 測量費。空なら取引の「測量費」を使う。 */
  surveyFee: yenInt.nullable(),
  /** 解体費(区分は出さない)。 */
  demolitionFee: yenInt.nullable(),
  loanBalance: yenInt.nullable(),
  others: z.array(otherCostSchema).max(10),
  /** 取得費。空 = 不明(売却価格の5%で計算)。 */
  acquisitionCost: yenInt.nullable(),
  /** 取得日。空なら譲渡所得税の目安は出さない。 */
  acquiredOn: isoDate.nullable(),
  residentialDeduction: z.boolean(),
}).strict();
export type FundingSaleInputs = z.output<typeof fundingSaleSchema>;

export const fundingInputsSchema = z.object({
  mode: z.enum(["purchase", "sale"]),
  /** お客様名(購入・売却で共通・切り替えても消えない)。 */
  customerName: text(100),
  /** 売買契約書の印紙: 全額 / 折半。 */
  stampShare: z.enum(["full", "half"]),
  purchase: fundingPurchaseSchema,
  sale: fundingSaleSchema,
}).strict();
export type FundingInputs = z.output<typeof fundingInputsSchema>;

export const DEFAULT_FUNDING_INPUTS: FundingInputs = {
  mode: "purchase",
  customerName: null,
  stampShare: "full",
  purchase: {
    registrationTransfer: null, registrationPreservation: null, registrationMortgage: null, scrivenerFee: null,
    loanFeeType: "fixed", loanFeeFixed: null, loanFeeRateBp: null, loanGuarantee: null, fireInsurance: null,
    acquisitionTax: null, others: [], ownFunds: null, loanAmount: null, loans: [{ annualRateBp: 100, years: 35 }],
  },
  sale: {
    mortgageCancellation: null, surveyFee: null, demolitionFee: null, loanBalance: null, others: [],
    acquisitionCost: null, acquiredOn: null, residentialDeduction: false,
  },
};

const obj = (json: unknown): Record<string, unknown> =>
  json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};

/** `plan_inputs` 列から資金計画表の入力を読む。足りない項目は初期値で補い、それでも壊れていれば初期値。 */
export function readFundingInputs(planInputs: unknown): FundingInputs {
  const f = obj(obj(planInputs).funding);
  const r = fundingInputsSchema.safeParse({
    ...DEFAULT_FUNDING_INPUTS, ...f,
    purchase: { ...DEFAULT_FUNDING_INPUTS.purchase, ...obj(f.purchase) },
    sale: { ...DEFAULT_FUNDING_INPUTS.sale, ...obj(f.sale) },
  });
  return r.success ? r.data : DEFAULT_FUNDING_INPUTS;
}
