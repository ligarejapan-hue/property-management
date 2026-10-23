export interface BrokerageTiers {
  tiers: { upTo: number | null; rateBp: number }[];
  lowCostSpecial: { priceLimit: number; feeCap: number };
}
export interface BrokerageResult { excl: number; incl: number; specialApplied: boolean }

/**
 * 仲介手数料の上限(依頼書 3.1)。段ごとの「部分×率」を足し、税抜は最後に1回だけ円未満切り捨て。
 * 低廉な空家等の特例(オン かつ 価格が上限以下)は、上限額を特例の額にする。
 * 税込 = 税抜 × (1 + 税率)、円未満切り捨て。
 */
export function brokerageFee(
  price: number,
  t: BrokerageTiers,
  opts: { lowCostSpecial: boolean; taxRateBp: number },
): BrokerageResult {
  let lower = 0;
  let numer = 0; // Σ 部分 × rateBp(÷10000 は最後に1回)
  for (const tier of t.tiers) {
    const upper = tier.upTo ?? Number.POSITIVE_INFINITY;
    numer += Math.max(0, Math.min(price, upper) - lower) * tier.rateBp;
    if (price <= upper) break;
    lower = upper;
  }
  let excl = Math.floor(numer / 10000);
  const specialApplied = opts.lowCostSpecial && price <= t.lowCostSpecial.priceLimit;
  if (specialApplied) excl = Math.max(excl, t.lowCostSpecial.feeCap);
  const incl = Math.floor((excl * (10000 + opts.taxRateBp)) / 10000);
  return { excl, incl, specialApplied };
}
