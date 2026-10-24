import { describe, expect, it } from "vitest";
import { businessPlanCalc } from "../business-plan";
import { computeDealCalc } from "../deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS, type BusinessInputs } from "../../business-schema";
import type { DealView } from "../../view";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
/** 架空の買取再販の取引(区分・仕入 2,000万円・決済 2026-06-01)。 */
const deal: DealView = {
  id: "d", dealNo: "2026-0009", name: "試験", businessType: "resale", tradeSide: null, status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-05-31T15:00:00.000Z", settlementPlace: null,
  price: 20_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, address: "架空県架空市1-2-3", floorArea: 60.5, landArea: 1000 },
  counterpartyBroker: EMPTY_BROKER,
  assessments: { rows: [{ building: 6_000_000, land: 4_000_000, shareNum: 1, shareDen: 1 }], landRatioBp: 10000 },
  costs: { ...DEFAULT_COSTS, registrationFee: 300_000 },
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 60_000, cityPlanningTax: 13_000, managementFee: 15_000, repairReserve: 5_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const inputs: BusinessInputs = {
  ...DEFAULT_BUSINESS_INPUTS,
  purchaseBrokerage: 726_000, outsourcingFee: 100_000, acquisitionTax: 200_000, settlementPaid: 50_000,
  acquisitionOthers: [{ label: "鍵交換", amount: 20_000 }],
  interiorCost: 3_000_000,
  saleDate: "2026-11-30", loanAmount: 18_000_000, loanRateBp: 200,
  salePrice: 28_000_000, saleBrokerage: 990_000, mortgageCancellation: 30_000,
};
const calc = (i: BusinessInputs = inputs, d: DealView = deal) =>
  businessPlanCalc(d, computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24"), i, rateRows);

describe("事業計画書の計算", () => {
  it("最終レビュー: 出さないセクションの費用は経費合計に入れない(仕入価格はいつも入れる)", () => {
    const all = calc();
    const noReno = businessPlanCalc(deal, computeDealCalc(deal, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24"), inputs, rateRows,
      ["overview", "purchase", "acquisition", "holding", "sale", "profit"]);
    expect(noReno.profit.costTotal).toBe(all.profit.costTotal - 3_000_000);
    const only = businessPlanCalc(deal, computeDealCalc(deal, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24"), inputs, rateRows, ["profit"]);
    expect(only.profit.costTotal).toBe(20_000_000);
  });
  it("仕入: 税込は売買価格・建物消費税は家屋割合で按分・税抜は差し引き", () => {
    const c = calc();
    expect(c.purchase).toEqual({ priceIncl: 20_000_000, buildingTax: 1_090_909, priceExcl: 18_909_091 });
  });
  it("取得経費: 入力・取引の登記費用・印紙(軽減の表・全額)を足す", () => {
    const c = calc();
    const amount = (k: string) => c.acquisition.lines.find((l) => l.key === k)?.amount;
    expect(amount("brokerage")).toBe(726_000);
    expect(amount("stamp")).toBe(10_000);
    expect(amount("registration")).toBe(300_000);
    expect(amount("settlement")).toBe(50_000);
    expect(c.acquisition.total).toBe(1_406_000);
    expect(calc({ ...inputs, stampShare: "half" }).acquisition.lines.find((l) => l.key === "stamp")?.amount).toBe(5_000);
    expect(calc({ ...inputs, registrationFee: 120_000 }).acquisition.lines.find((l) => l.key === "registration")?.amount).toBe(120_000);
  });
  it("精算金を空にすると、決済の計算の差引(自社が払う向き)を使う", () => {
    const d = computeDealCalc(deal, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    const c = calc({ ...inputs, settlementPaid: null });
    const expected = d.settlement.net.direction === "buyerToSeller" ? d.settlement.net.amount : d.settlement.net.direction === "sellerToBuyer" ? -d.settlement.net.amount : 0;
    expect(expected).not.toBe(0);
    expect(c.acquisition.lines.find((l) => l.key === "settlement")?.amount).toBe(expected);
  });
  it("保有コスト: 決済日〜販売予定日の日数(両端を含む)で利息・固都税・管理費等を日割り(切り捨て)", () => {
    const h = calc().holding;
    expect(h.days).toBe(183);
    expect(h.interest).toBe(180_493);
    expect(h.propertyTax).toBe(36_600);
    expect(h.management).toBe(120_328);
    expect(h.total).toBe(337_421);
  });
  it("販売: 建物消費税は仕入と同じ割合で按分・手で直せる・費用は入力と印紙", () => {
    const c = calc();
    expect(c.sale).toMatchObject({ priceIncl: 28_000_000, buildingTax: 1_527_272, priceExcl: 26_472_728, total: 1_030_000 });
    expect(calc({ ...inputs, saleBuildingTax: 1_000_000 }).sale.priceExcl).toBe(27_000_000);
  });
  it("収支: 経費合計・粗利・利益率(0.01% 単位の切り捨て)・損益分岐・坪単価", () => {
    expect(calc().profit).toEqual({
      revenue: 28_000_000, costTotal: 25_773_421, gross: 2_226_579, marginBp: 795, breakEven: 25_773_421,
      purchaseTsuboPrice: 1_092_821, saleTsuboPrice: 1_529_950,
    });
  });
  it("赤字の利益率は 0 に向けて切り捨て", () => {
    const p = calc({ ...inputs, salePrice: 20_000_000 }).profit;
    expect(p.gross).toBeLessThan(0);
    expect(p.marginBp).toBe(Math.trunc((p.gross! * 10000) / 20_000_000));
  });
  it("坪単価: 区分は専有面積、それ以外は土地面積・面積が無ければ出さない", () => {
    const house = { ...deal, propertyKind: "house" };
    expect(calc(inputs, house).areaSqm).toBe(1000);
    expect(calc(inputs, { ...deal, propertySnapshot: { ...deal.propertySnapshot, floorArea: null } }).profit.purchaseTsuboPrice).toBeNull();
  });
  it("仲介手数料の上限額(ボタンで入れる額): 仕入・販売の価格の上限(税込)", () => {
    expect(calc().brokerageCap).toEqual({ purchase: 726_000, sale: 990_000 });
  });
  it("足りない項目: 販売予定日・売却価格・決済日が無ければ、保有コスト・収支を空にして知らせる(NaN にしない)", () => {
    const c = calc({ ...inputs, saleDate: null, salePrice: null }, { ...deal, settlementAt: null });
    expect(c.holding).toMatchObject({ days: null, interest: 0, propertyTax: 0, management: 0, total: 0 });
    expect(c.profit).toMatchObject({ revenue: null, gross: null, marginBp: null, saleTsuboPrice: null });
    expect(c.missing).toEqual(expect.arrayContaining(["決済日", "販売予定日", "売却価格"]));
    expect(JSON.stringify(c)).not.toMatch(/NaN|Infinity/);
    expect(calc({ ...inputs, saleDate: "2026-05-01" }).missing).toContain("販売予定日(決済日より前になっています)");
  });
  it("資金計画: 自己資金・借入額・借入期間・返済方法", () => {
    expect(calc({ ...inputs, ownFunds: 5_000_000, loanMonths: 12, repayment: "lump" }).financing).toEqual({
      ownFunds: 5_000_000, loanAmount: 18_000_000, loanMonths: 12, repayment: "lump",
    });
  });
  it("OC収支: OC ありだけ・年間収入・表面利回り・NOI(運営費は固都税+管理費等の年額)・NET利回り・入居状況", () => {
    expect(calc().oc).toBeNull();
    const oc = { ...deal, hasOc: true, leases: [
      { room: "101", tenant: "架空 一郎", contractType: "ordinary" as const, period: null, rent: 100_000, commonFee: 5_000, parking: 0, other: 0, deposit: 200_000, arrears: false, arrearsAmount: 0, manager: null },
    ] };
    expect(calc(inputs, oc).oc).toEqual({
      annualIncome: 1_260_000, grossYieldBp: 630, annualExpenses: 313_000, noi: 947_000, netYieldBp: 442,
      rooms: 1, occupied: 1, arrearsRooms: 0, arrearsAmount: 0,
    });
    expect(calc({ ...inputs, ocAnnualExpenses: 100_000 }, oc).oc?.noi).toBe(1_160_000);
  });
});
