import type { BasePropertyKind } from "../constants";
import type { BusinessInputs } from "../business-schema";
import { jstDateString } from "../datetime";
import type { RateTableRow } from "../rate-tables";
import type { DealView } from "../view";
import { brokerageFee } from "./brokerage";
import { buildingPriceApportion, buildingTaxOf } from "./building-tax";
import { daysInclusive } from "./dates";
import { pickRateContent, type DealCalc } from "./deal-calc";
import { contractStamp } from "./stamp";

export interface BusinessLine {
  key: string;
  label: string;
  /** 空欄は null(合計には 0 として入れる)。 */
  amount: number | null;
}

export interface BusinessPlanCalc {
  kindBase: BasePropertyKind | null;
  /** 坪単価に使う面積(㎡)。区分=専有面積、それ以外=土地面積。 */
  areaSqm: number | null;
  purchase: { priceIncl: number | null; buildingTax: number | null; priceExcl: number | null };
  acquisition: { lines: BusinessLine[]; total: number };
  renovation: { lines: BusinessLine[]; total: number };
  /** days は決済日・販売予定日が揃わなければ null(そのとき金額は 0)。 */
  holding: { days: number | null; interest: number; propertyTax: number; management: number; total: number };
  sale: { priceIncl: number | null; buildingTax: number | null; priceExcl: number | null; lines: BusinessLine[]; total: number };
  profit: {
    revenue: number | null; costTotal: number; gross: number | null;
    /** 利益率(1/100 %)。0 に向けて切り捨て。 */
    marginBp: number | null;
    /** 粗利が 0 になる売上(販売の費用は今の売却価格のときの額)。 */
    breakEven: number;
    purchaseTsuboPrice: number | null; saleTsuboPrice: number | null;
  };
  financing: { ownFunds: number | null; loanAmount: number | null; loanMonths: number | null; repayment: BusinessInputs["repayment"] };
  /** OC ありのときだけ。 */
  oc: {
    annualIncome: number; grossYieldBp: number | null; annualExpenses: number; noi: number; netYieldBp: number | null;
    rooms: number; occupied: number; arrearsRooms: number; arrearsAmount: number;
  } | null;
  /** 「上限額を入れる」ボタンで入れる仲介手数料(税込)。表や価格が無ければ null。 */
  brokerageCap: { purchase: number | null; sale: number | null };
  missing: string[];
}

const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const others = (prefix: string, xs: { label: string; amount: number }[]): BusinessLine[] =>
  xs.map((o, i) => ({ key: `${prefix}-${i}`, label: o.label, amount: o.amount }));
/** 坪数 = ㎡ × 0.3025。坪単価は円未満切り捨て。 */
const tsuboPrice = (price: number | null, area: number | null) =>
  price === null || area === null || area <= 0 ? null : Math.floor(price / (area * 0.3025));
/** 割合(1/100 %)。0 に向けて切り捨て。分母が 0 以下なら null。 */
const ratioBp = (n: number, d: number) => (d > 0 ? Math.trunc((n * 10000) / d) : null);

/**
 * 事業計画書(依頼書 4.2・買取再販)。計画の読み替え 3〜11 のとおり。端数はすべて円未満切り捨て。
 * 仕入価格 = 取引の売買価格。建物消費税・登記費用・精算金は取引の計算(`computeDealCalc`)の値を使い、入力があればそれを使う。
 */
export function businessPlanCalc(deal: DealView, dc: DealCalc, i: BusinessInputs, rateRows: RateTableRow[]): BusinessPlanCalc {
  const missing: string[] = [];
  const price = deal.price;
  if (price === null) missing.push("売買価格");
  const settlementDate = deal.settlementAt ? jstDateString(new Date(deal.settlementAt)) : null;
  if (!settlementDate) missing.push("決済日");
  if (!i.saleDate) missing.push("販売予定日");
  if (i.salePrice === null) missing.push("売却価格");
  const saleBaseDate = i.saleDate ?? dc.baseDate;

  // 仕入
  const purchaseTax = dc.building.tax;
  const purchase = {
    priceIncl: price, buildingTax: purchaseTax,
    priceExcl: price === null ? null : price - (purchaseTax ?? 0),
  };

  // 取得経費
  const stampTable = pickRateContent(rateRows, "stamp_contract", dc.baseDate);
  const net = dc.settlement.net;
  const settlementFromCalc = !dc.settlement.ready ? null : net.direction === "buyerToSeller" ? net.amount : net.direction === "sellerToBuyer" ? -net.amount : 0;
  const acquisitionLines: BusinessLine[] = [
    { key: "brokerage", label: "仲介手数料", amount: i.purchaseBrokerage },
    { key: "outsourcing", label: "業務委託料", amount: i.outsourcingFee },
    { key: "stamp", label: "印紙(売買契約書)", amount: price !== null && stampTable ? contractStamp(price, stampTable, i.stampShare) : null },
    { key: "registration", label: "登記費用", amount: i.registrationFee ?? deal.costs.registrationFee },
    { key: "acquisitionTax", label: "不動産取得税", amount: i.acquisitionTax },
    { key: "settlement", label: "精算金(固都税・管理費など)", amount: i.settlementPaid ?? settlementFromCalc },
    ...others("acq-other", i.acquisitionOthers),
  ];
  const acquisition = { lines: acquisitionLines, total: sum(acquisitionLines.map((l) => l.amount)) };

  // 改装・工事
  const renovationLines: BusinessLine[] = [
    { key: "interior", label: "内装費", amount: i.interiorCost },
    { key: "demolition", label: "解体費", amount: i.demolitionCost },
  ];
  const renovation = { lines: renovationLines, total: sum(renovationLines.map((l) => l.amount)) };

  // 保有コスト(事業期間 = 決済日 〜 販売予定日・両端を含む)
  let days: number | null = null;
  if (settlementDate && i.saleDate) {
    if (i.saleDate < settlementDate) missing.push("販売予定日(決済日より前になっています)");
    else days = daysInclusive(settlementDate, i.saleDate);
  }
  const t = deal.settlementTerms;
  const annualPropertyTax = (t.fixedAssetTax ?? 0) + (t.cityPlanningTax ?? 0);
  const monthlyManagement = (t.managementFee ?? 0) + (t.repairReserve ?? 0) + (t.otherMonthly ?? 0);
  const interest = days === null ? 0 : Math.floor(((i.loanAmount ?? 0) * i.loanRateBp * days) / (10000 * 365));
  const propertyTax = days === null ? 0 : Math.floor((annualPropertyTax * days) / 365);
  const management = days === null ? 0 : Math.floor((monthlyManagement * 12 * days) / 365);
  const holding = { days, interest, propertyTax, management, total: interest + propertyTax + management };

  // 販売(建物消費税は仕入と同じ家屋割合で按分)
  const salePrice = i.salePrice;
  const saleBuildingPrice = salePrice === null ? null : buildingPriceApportion(salePrice, deal.assessments.rows, deal.assessments.landRatioBp);
  const saleTax = i.saleBuildingTax ?? (saleBuildingPrice === null ? null : buildingTaxOf(saleBuildingPrice, deal.taxRateBp));
  const saleStampTable = pickRateContent(rateRows, "stamp_contract", saleBaseDate);
  const saleLines: BusinessLine[] = [
    { key: "brokerage", label: "仲介手数料", amount: i.saleBrokerage },
    { key: "stamp", label: "印紙(売買契約書)", amount: salePrice !== null && saleStampTable ? contractStamp(salePrice, saleStampTable, i.stampShare) : null },
    { key: "mortgageCancellation", label: "抵当権抹消", amount: i.mortgageCancellation },
    { key: "survey", label: "測量", amount: i.surveyFee },
    ...others("sale-other", i.saleOthers),
  ];
  const sale = {
    priceIncl: salePrice, buildingTax: saleTax, priceExcl: salePrice === null ? null : salePrice - (saleTax ?? 0),
    lines: saleLines, total: sum(saleLines.map((l) => l.amount)),
  };

  // 収支
  const areaSqm = dc.kindBase === "unit" ? deal.propertySnapshot.floorArea : deal.propertySnapshot.landArea;
  const costTotal = (price ?? 0) + acquisition.total + renovation.total + holding.total + sale.total;
  const gross = salePrice === null ? null : salePrice - costTotal;
  const profit = {
    revenue: salePrice, costTotal, gross,
    marginBp: gross === null || salePrice === null ? null : ratioBp(gross, salePrice),
    breakEven: costTotal,
    purchaseTsuboPrice: tsuboPrice(price, areaSqm), saleTsuboPrice: tsuboPrice(salePrice, areaSqm),
  };

  // OC収支
  let oc: BusinessPlanCalc["oc"] = null;
  if (deal.hasOc) {
    const annualIncome = sum(deal.leases.map((l) => (l.rent + l.commonFee + l.parking + l.other) * 12));
    const annualExpenses = i.ocAnnualExpenses ?? annualPropertyTax + monthlyManagement * 12;
    const noi = annualIncome - annualExpenses;
    oc = {
      annualIncome, grossYieldBp: price === null ? null : ratioBp(annualIncome, price), annualExpenses, noi,
      netYieldBp: price === null ? null : ratioBp(noi, price + acquisition.total),
      rooms: deal.leases.length, occupied: deal.leases.filter((l) => l.tenant).length,
      arrearsRooms: deal.leases.filter((l) => l.arrears).length, arrearsAmount: sum(deal.leases.map((l) => (l.arrears ? l.arrearsAmount : 0))),
    };
  }

  // 仲介手数料の上限額(ボタン用)
  const cap = (p: number | null, date: string) => {
    const tiers = pickRateContent(rateRows, "brokerage_tiers", date);
    return p === null || !tiers ? null : brokerageFee(p, tiers, { lowCostSpecial: deal.costs.lowCostSpecial, taxRateBp: deal.taxRateBp }).incl;
  };

  return {
    kindBase: dc.kindBase, areaSqm: areaSqm ?? null, purchase, acquisition, renovation, holding, sale, profit,
    financing: { ownFunds: i.ownFunds, loanAmount: i.loanAmount, loanMonths: i.loanMonths, repayment: i.repayment },
    oc, brokerageCap: { purchase: cap(price, dc.baseDate), sale: cap(salePrice, saleBaseDate) }, missing,
  };
}
