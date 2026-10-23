export interface AssessmentRow { building: number; land: number; shareNum: number; shareDen: number }

type Frac = { n: bigint; d: bigint };
const add = (a: Frac, n: bigint, d: bigint): Frac => ({ n: a.n * d + n * a.d, d: a.d * d });

/**
 * 建物価格(税込)の按分(依頼書 3.4)。評価額は筆ごとに「評価額×持分」を合計し、土地には土地の割合を掛ける。
 * 建物価格 = 売買価格 × 家屋 ÷ (家屋 + 土地)。持分の分数で誤差が出ないよう整数の分数(BigInt)で計算し、
 * 最後に1回だけ円未満を切り捨てる。評価額が無い・合計0のときは null(計算できない)。
 */
export function buildingPriceApportion(price: number, rows: AssessmentRow[], landRatioBp: number): number | null {
  let h: Frac = { n: BigInt(0), d: BigInt(1) };
  let l: Frac = { n: BigInt(0), d: BigInt(1) };
  for (const r of rows) {
    h = add(h, BigInt(r.building) * BigInt(r.shareNum), BigInt(r.shareDen));
    l = add(l, BigInt(r.land) * BigInt(r.shareNum) * BigInt(landRatioBp), BigInt(r.shareDen) * BigInt(10000));
  }
  const num = h.n * l.d;
  const den = h.n * l.d + l.n * h.d;
  if (den === BigInt(0)) return null;
  return Number((BigInt(price) * num) / den);
}

/** 建物消費税 = 建物価格(税込) × 税率 ÷ (1 + 税率)、円未満切り捨て。 */
export function buildingTaxOf(buildingPriceInclTax: number, taxRateBp: number): number {
  return Math.floor((buildingPriceInclTax * taxRateBp) / (10000 + taxRateBp));
}
