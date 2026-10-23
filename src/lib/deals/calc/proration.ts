import { addDays, daysInMonth, daysInclusive, parseYmd, ymd } from "./dates";
import { yen } from "./format";

export type TaxStart = "01-01" | "04-01";

/**
 * 固都税の日割り(依頼書 3.2)。決済日の前日までを売主、決済日からを買主の負担にする。
 * 期間 = 決済日を含む「起算日から1年」(うるう日を含めば366日)。
 * 端数: 買主分を先に出して円未満切り捨て、売主分 = 年税額 − 買主分。
 */
export function prorateAnnualTax(annual: number, start: TaxStart, settlement: string) {
  const { y, m, d } = parseYmd(settlement);
  const [sm, sd] = start === "01-01" ? [1, 1] : [4, 1];
  const startYear = m > sm || (m === sm && d >= sd) ? y : y - 1;
  const periodStart = ymd(startYear, sm, sd);
  const periodEnd = addDays(ymd(startYear + 1, sm, sd), -1);
  const yearDays = daysInclusive(periodStart, periodEnd);
  const buyerDays = daysInclusive(settlement, periodEnd);
  const buyer = Math.floor((annual * buyerDays) / yearDays);
  const warning = start === "04-01" && m <= 3
    ? `起算日が4月1日のため、計算期間は ${periodStart}〜${periodEnd} です。どの年度の税額か確かめてください。`
    : null;
  return {
    buyer, seller: annual - buyer, periodStart, periodEnd, yearDays, buyerDays,
    formula: `${yen(annual)}円×${buyerDays}日÷${yearDays}日`, warning,
  };
}

/**
 * 月額の日割り(管理費等・賃料)。決済月の月額を日割りし(決済日から月末まで)、前払い月数分を足す。
 * 端数: 当月分は円未満切り捨て。前払い分は 月額×月数。
 */
export function prorateMonthly(monthly: number, settlement: string, prepaidMonths: number) {
  const { y, m, d } = parseYmd(settlement);
  const monthDays = daysInMonth(y, m);
  const buyerDays = monthDays - d + 1;
  const current = Math.floor((monthly * buyerDays) / monthDays);
  const prepaid = monthly * prepaidMonths;
  const formula = `${yen(monthly)}円×${buyerDays}日÷${monthDays}日` + (prepaidMonths > 0 ? `＋${yen(monthly)}円×${prepaidMonths}か月` : "");
  return { current, prepaid, total: current + prepaid, buyerDays, monthDays, formula };
}
