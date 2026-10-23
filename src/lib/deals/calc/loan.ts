/**
 * 元利均等返済の月額(依頼書 3.6)。月利 = 年利 ÷ 12。金利0%は 借入額 ÷ 回数。
 * 端数: 円未満切り捨て(浮動小数の誤差で x.99999… になるのを避けるため、ごく小さい値を足してから切り捨てる)。
 */
export function loanPayment(principal: number, annualRateBp: number, years: number): number {
  const n = Math.round(years * 12);
  if (principal <= 0 || n <= 0) return 0;
  if (annualRateBp === 0) return Math.floor(principal / n);
  const r = annualRateBp / 10000 / 12;
  const f = Math.pow(1 + r, n);
  return Math.floor((principal * r * f) / (f - 1) + 1e-7);
}
