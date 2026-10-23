export interface CapitalGainsRates {
  long: { incomeTaxBp: number; residentTaxBp: number };
  short: { incomeTaxBp: number; residentTaxBp: number };
  reconstructionBp: number;
  longTermYears: number;
  residentialDeduction: number;
  unknownCostRateBp: number;
}
export interface CapitalGainsInput {
  salePrice: number;
  /** 分からないときは null(売却価格の5%で計算する)。 */
  acquisitionCost: number | null;
  sellingCosts: number;
  acquiredOn: string;
  saleDate: string;
  residentialDeduction: boolean;
}

export const CAPITAL_GAINS_NOTE = "概算です。正確な税額は税理士にご確認ください。";

/**
 * 譲渡所得税の目安(依頼書 3.7)。
 * 端数: 取得費の5%は円未満切り捨て・課税譲渡所得は千円未満切り捨て・税額は税目ごとに百円未満切り捨て。
 * 長期 = 売却年の1月1日時点で所有期間が5年を超える(取得日 < (売却年−5)年1月1日)。
 */
export function capitalGainsEstimate(i: CapitalGainsInput, r: CapitalGainsRates) {
  const usedEstimatedCost = i.acquisitionCost === null;
  const acquisitionCost = i.acquisitionCost ?? Math.floor((i.salePrice * r.unknownCostRateBp) / 10000);
  const gain = i.salePrice - (acquisitionCost + i.sellingCosts);
  const deduction = i.residentialDeduction ? Math.min(Math.max(gain, 0), r.residentialDeduction) : 0;
  const taxable = Math.floor(Math.max(0, gain - deduction) / 1000) * 1000;
  const saleYear = Number(i.saleDate.slice(0, 4));
  const longTerm = i.acquiredOn < `${saleYear - r.longTermYears}-01-01`;
  const k = longTerm ? r.long : r.short;
  const hundred = (v: number) => Math.floor(v / 100) * 100;
  const incomeTax = hundred((taxable * k.incomeTaxBp) / 10000);
  const reconstructionTax = hundred((incomeTax * r.reconstructionBp) / 10000);
  const residentTax = hundred((taxable * k.residentTaxBp) / 10000);
  return {
    acquisitionCost, usedEstimatedCost, gain, deduction, taxable, longTerm,
    incomeTax, reconstructionTax, residentTax, total: incomeTax + reconstructionTax + residentTax,
    note: CAPITAL_GAINS_NOTE,
  };
}
