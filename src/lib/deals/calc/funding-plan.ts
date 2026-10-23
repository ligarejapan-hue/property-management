import type { BasePropertyKind } from "../constants";
import type { FundingInputs } from "../funding-schema";
import type { RateTableRow } from "../rate-tables";
import type { DealView } from "../view";
import { capitalGainsEstimate, CAPITAL_GAINS_NOTE } from "./capital-gains";
import { pickRateContent, type DealCalc } from "./deal-calc";
import { loanPayment } from "./loan";
import { contractStamp } from "./stamp";

export interface FundingLine {
  key: string;
  label: string;
  /** 空欄は null(合計には 0 として入れる)。 */
  amount: number | null;
}

export interface FundingLoanResult { annualRateBp: number; years: number; monthly: number; monthlyTotal: number }

export interface FundingPurchaseResult {
  lines: FundingLine[];
  costsTotal: number;
  /** 必要な資金の合計 = 物件価格 + 諸費用。価格が無ければ null。 */
  total: number | null;
  loanAmount: number;
  /** 借入額の決め方: 入力 / 自己資金から逆算 / 物件価格。 */
  loanSource: "input" | "ownFunds" | "price";
  /** 自己資金(表示)= 合計 − 借入額。 */
  ownFunds: number | null;
  loans: FundingLoanResult[];
  /** 区分の管理費・修繕積立金・その他の月額。区分以外は null。 */
  monthlyHousing: number | null;
  notes: string[];
}

export interface FundingSaleResult {
  lines: FundingLine[];
  costsTotal: number;
  loanBalance: number;
  /** 精算金(売主が受け取る向きを+)。決済日が無ければ 0。 */
  settlementReceive: number;
  /** 預り敷金の承継で残代金から差し引く額(相殺のときだけ・OC)。 */
  depositOffset: number;
  /** 手取り(税引前)。価格が無ければ null。 */
  netBeforeTax: number | null;
  tax: ReturnType<typeof capitalGainsEstimate> | null;
  netAfterTax: number | null;
  taxNote: string;
  notes: string[];
}

export interface FundingPlanCalc {
  mode: FundingInputs["mode"];
  kindBase: BasePropertyKind | null;
  price: number | null;
  missing: string[];
  purchase: FundingPurchaseResult;
  sale: FundingSaleResult;
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const otherLines = (xs: { label: string; amount: number }[]): FundingLine[] =>
  xs.map((o, i) => ({ key: `other-${i}`, label: o.label, amount: o.amount }));

/**
 * 資金計画表(依頼書 4.1)。手数料・印紙・精算は取引の計算(`computeDealCalc`)と同じ値を使う。
 * 端数: 定率の事務手数料は円未満切り捨て・印紙の折半は切り捨て(contractStamp)・月返済額は loanPayment(切り捨て)。
 * 精算金は敷金を除いた差引(購入=買主が払う向きを+・売却=売主が受け取る向きを+)。
 */
export function fundingPlanCalc(deal: DealView, dc: DealCalc, inputs: FundingInputs, rateRows: RateTableRow[]): FundingPlanCalc {
  const kind = dc.kindBase;
  const price = deal.price;
  const missing = price === null ? ["売買価格"] : [];
  const stampTable = pickRateContent(rateRows, "stamp_contract", dc.baseDate);
  const stamp = price !== null && stampTable ? contractStamp(price, stampTable, inputs.stampShare) : null;
  // 買取再販(自社が売主・買主)では仲介手数料はかからない(最終レビュー)。
  const isBrokerage = deal.businessType === "brokerage";
  const brokerage = isBrokerage ? dc.brokerage?.incl ?? null : null;
  const brokerageLines: FundingLine[] = isBrokerage ? [{ key: "brokerage", label: "仲介手数料(税込)", amount: brokerage }] : [];
  const s = dc.settlement;
  const settlementNet = s.ready ? s.totalBuyerToSeller - s.totalSellerToBuyer : null;
  // OC の預り敷金を残代金と相殺するときは、買主の払う額・売主の受け取る額がその分だけ減る(別途授受なら入れない)。
  const depositOffset = s.ready ? s.depositOffset : 0;
  const commonNotes: string[] = [];
  if (isBrokerage && brokerage === null) commonNotes.push("仲介手数料は、売買価格と手数料の表がそろうと入ります。");
  if (!s.ready) commonNotes.push("精算金は、取引の基本タブで決済日時を入れると入ります。");
  // 印紙の表が契約日に当たらないとき、黙って 0 円にしない(@codex)。
  if (price !== null && !stampTable) commonNotes.push("印紙税の表が契約日に当たらないため、印紙を入れていません(取引の設定で表を確かめてください)。");

  // ---- 購入 ----
  const p = inputs.purchase;
  const building = kind !== "land";
  const pNotes = [...commonNotes];
  const linesBeforeFee: FundingLine[] = [
    ...brokerageLines,
    { key: "stamp", label: "印紙(売買契約書)", amount: stamp },
    { key: "registrationTransfer", label: "登記費用(所有権移転)", amount: p.registrationTransfer ?? deal.costs.registrationFee },
    ...(building ? [{ key: "registrationPreservation", label: "登記費用(保存)", amount: p.registrationPreservation }] : []),
    { key: "registrationMortgage", label: "登記費用(抵当権設定)", amount: p.registrationMortgage },
    { key: "scrivenerFee", label: "司法書士報酬", amount: p.scrivenerFee },
  ];
  const linesAfterFee: FundingLine[] = [
    { key: "loanGuarantee", label: "ローン保証料", amount: p.loanGuarantee },
    ...(building ? [{ key: "fireInsurance", label: "火災保険", amount: p.fireInsurance }] : []),
    ...(settlementNet !== null ? [{ key: "settlement", label: "精算金(固都税・管理費など)", amount: settlementNet }] : []),
    ...(depositOffset > 0 ? [{ key: "depositOffset", label: "預り敷金の承継(残代金と相殺)", amount: -depositOffset }] : []),
    { key: "acquisitionTax", label: "不動産取得税(目安)", amount: p.acquisitionTax },
    ...otherLines(p.others),
  ];
  const costsExFee = sum([...linesBeforeFee, ...linesAfterFee].map((l) => l.amount));
  const fixedFee = p.loanFeeType === "fixed" ? p.loanFeeFixed ?? 0 : 0;

  let loanAmount: number;
  let loanSource: FundingPurchaseResult["loanSource"];
  if (p.loanAmount !== null) {
    loanAmount = p.loanAmount;
    loanSource = "input";
  } else if (p.ownFunds !== null) {
    // 定率の事務手数料は借入額で決まるので、逆算のときは除いて循環を断つ(固定額は含める)。
    loanAmount = Math.max(0, (price ?? 0) + costsExFee + fixedFee - p.ownFunds);
    loanSource = "ownFunds";
    if (p.loanFeeType === "rate") pNotes.push("定率の事務手数料は借入額から決まるため、自己資金はその分だけ多く表示されます。");
  } else {
    loanAmount = price ?? 0;
    loanSource = "price";
  }
  const loanFee = p.loanFeeType === "rate"
    ? (p.loanFeeRateBp === null ? null : Math.floor((loanAmount * p.loanFeeRateBp) / 10000))
    : p.loanFeeFixed;
  const lines = [...linesBeforeFee, { key: "loanFee", label: "ローン事務手数料", amount: loanFee }, ...linesAfterFee];
  const costsTotal = sum(lines.map((l) => l.amount));
  const total = price === null ? null : price + costsTotal;
  const ownFunds = total === null ? null : total - loanAmount;
  if (ownFunds !== null && ownFunds < 0) pNotes.push("借入額が必要な資金の合計を超えています。");
  const t = deal.settlementTerms;
  const monthlyHousing = kind === "unit" ? sum([t.managementFee, t.repairReserve, t.otherMonthly]) : null;
  const loans = p.loans.map((l) => {
    const monthly = loanPayment(loanAmount, l.annualRateBp, l.years);
    return { ...l, monthly, monthlyTotal: monthly + (monthlyHousing ?? 0) };
  });

  // ---- 売却 ----
  const v = inputs.sale;
  const sNotes = [...commonNotes];
  const surveyFee = v.surveyFee ?? deal.costs.surveyFee;
  const demolition = kind !== "unit" ? v.demolitionFee : null;
  const sLines: FundingLine[] = [
    ...brokerageLines,
    { key: "stamp", label: "印紙(売買契約書)", amount: stamp },
    { key: "mortgageCancellation", label: "抵当権抹消費用", amount: v.mortgageCancellation ?? deal.costs.cancellationFee },
    { key: "surveyFee", label: "測量費", amount: surveyFee },
    ...(kind !== "unit" ? [{ key: "demolitionFee", label: "解体費", amount: demolition }] : []),
    ...otherLines(v.others),
  ];
  const sCostsTotal = sum(sLines.map((l) => l.amount));
  const loanBalance = v.loanBalance ?? 0;
  const settlementReceive = settlementNet ?? 0;
  const netBeforeTax = price === null ? null : price - sCostsTotal - loanBalance + settlementReceive - depositOffset;
  const cg = pickRateContent(rateRows, "capital_gains", dc.baseDate);
  let tax: FundingSaleResult["tax"] = null;
  if (price === null) {
    // 価格が無ければ目安は出さない(missing に出る)。
  } else if (!v.acquiredOn) {
    sNotes.push("譲渡所得税の目安は、取得日を入れると出ます。");
  } else if (!cg) {
    sNotes.push("譲渡所得税の表が売却日に当たらないため、目安を出せません。");
  } else {
    // 譲渡費用: 仲介手数料・印紙・測量費・解体費・その他(抵当権抹消とローン残債は入れない)。
    const sellingCosts = sum([brokerage, stamp, surveyFee, demolition, ...v.others.map((o) => o.amount)]);
    tax = capitalGainsEstimate({
      salePrice: price, acquisitionCost: v.acquisitionCost, sellingCosts, acquiredOn: v.acquiredOn,
      saleDate: dc.baseDate, residentialDeduction: v.residentialDeduction,
    }, cg);
  }

  return {
    mode: inputs.mode, kindBase: kind, price, missing,
    purchase: { lines, costsTotal, total, loanAmount, loanSource, ownFunds, loans, monthlyHousing, notes: pNotes },
    sale: {
      lines: sLines, costsTotal: sCostsTotal, loanBalance, settlementReceive, depositOffset, netBeforeTax, tax,
      netAfterTax: tax && netBeforeTax !== null ? netBeforeTax - tax.total : null, taxNote: CAPITAL_GAINS_NOTE, notes: sNotes,
    },
  };
}
