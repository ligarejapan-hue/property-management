import { z } from "zod";
import { isoDate, otherCostSchema, text, yenInt } from "./schema-parts";

/** 社内用(承認欄・社内メモあり)/銀行向け(どちらも出さない)。依頼書 4.2。 */
export const BUSINESS_VARIANTS = ["internal", "bank"] as const;
export type BusinessVariant = (typeof BUSINESS_VARIANTS)[number];
export const BUSINESS_VARIANT_LABELS: Record<BusinessVariant, string> = { internal: "社内用", bank: "銀行向け" };

const yen = yenInt.nullable();
const others = z.array(otherCostSchema).max(10);

/** 販売価格の根拠(近隣の成約・売出事例)の1行。 */
export const comparableSchema = z.object({
  kind: z.enum(["sold", "listed"]),
  name: text(100),
  /** 面積(㎡)。 */
  area: z.number().nonnegative().max(1_000_000).nullable(),
  price: yen,
  /** 成約・売出の時期(自由な書き方)。 */
  period: text(30),
  note: text(200),
}).strict();
export type Comparable = z.output<typeof comparableSchema>;
export const COMPARABLE_KIND_LABELS: Record<Comparable["kind"], string> = { sold: "成約", listed: "売出" };

/**
 * 事業計画書の入力(`plan_inputs.business`)。仕入価格は取引の売買価格を使う(ここには持たない)。
 * 空欄(null)は「取引の値・計算の値を使う」か「0 として扱う」(項目ごとに calc/business-plan.ts に書く)。
 */
export const businessInputsSchema = z.object({
  variant: z.enum(BUSINESS_VARIANTS),
  /** 売買契約書の印紙: 全額 / 折半(仕入・販売で共通)。 */
  stampShare: z.enum(["full", "half"]),
  // 取得経費
  purchaseBrokerage: yen,
  outsourcingFee: yen,
  /** 空なら取引の「登記費用」。 */
  registrationFee: yen,
  acquisitionTax: yen,
  /** 空なら決済の計算の差引(自社が払う向きを+)。 */
  settlementPaid: yen,
  acquisitionOthers: others,
  // 改装・工事
  interiorCost: yen,
  demolitionCost: yen,
  // 保有コスト
  /** 販売予定日。事業期間 = 取引の決済日 〜 この日。 */
  saleDate: isoDate.nullable(),
  loanAmount: yen,
  /** 借入金利(年・1/100 %)。 */
  loanRateBp: z.number().int().min(0).max(3000),
  // 販売
  salePrice: yen,
  /** 空なら仕入と同じ家屋割合で按分。 */
  saleBuildingTax: yen,
  saleBrokerage: yen,
  mortgageCancellation: yen,
  surveyFee: yen,
  saleOthers: others,
  // 資金計画(銀行向け)
  ownFunds: yen,
  loanMonths: z.number().int().min(1).max(600).nullable(),
  repayment: z.enum(["lump", "amortized"]),
  // OC収支
  /** 年間の運営費。空なら固都税の年額 + 管理費等の年額。 */
  ocAnnualExpenses: yen,
  // 販売価格の根拠(銀行向け)
  comparables: z.array(comparableSchema).max(10),
  /** 社内メモ(社内用だけに出す)。 */
  memo: text(1000),
}).strict();
export type BusinessInputs = z.output<typeof businessInputsSchema>;
export const REPAYMENT_LABELS: Record<BusinessInputs["repayment"], string> = { lump: "期限一括返済", amortized: "元利均等返済" };

export const DEFAULT_BUSINESS_INPUTS: BusinessInputs = {
  variant: "internal", stampShare: "full",
  purchaseBrokerage: null, outsourcingFee: null, registrationFee: null, acquisitionTax: null, settlementPaid: null, acquisitionOthers: [],
  interiorCost: null, demolitionCost: null,
  saleDate: null, loanAmount: null, loanRateBp: 200,
  salePrice: null, saleBuildingTax: null, saleBrokerage: null, mortgageCancellation: null, surveyFee: null, saleOthers: [],
  ownFunds: null, loanMonths: null, repayment: "lump",
  ocAnnualExpenses: null, comparables: [], memo: null,
};

const obj = (json: unknown): Record<string, unknown> =>
  json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};

/** `plan_inputs` 列から事業計画書の入力を読む。足りない項目は初期値で補い、それでも壊れていれば初期値。 */
export function readBusinessInputs(planInputs: unknown): BusinessInputs {
  const r = businessInputsSchema.safeParse({ ...DEFAULT_BUSINESS_INPUTS, ...obj(obj(planInputs).business) });
  return r.success ? r.data : DEFAULT_BUSINESS_INPUTS;
}
