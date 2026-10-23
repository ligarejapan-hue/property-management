import { describe, it, expect } from "vitest";
import { fundingPlanCalc } from "../funding-plan";
import { computeDealCalc } from "../deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS, type FundingInputs } from "../../funding-schema";
import type { DealView } from "../../view";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-05-01T01:00:00.000Z", contractPlace: null, settlementAt: "2026-07-01T01:00:00.000Z", settlementPlace: null,
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: EMPTY_SNAPSHOT, counterpartyBroker: EMPTY_BROKER,
  assessments: { rows: [], landRatioBp: 10000 },
  costs: { ...DEFAULT_COSTS, registrationFee: 300_000, cancellationFee: 30_000 },
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, cityPlanningTax: 20_000, managementFee: 20_000, repairReserve: 10_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [], fundingPlan: DEFAULT_FUNDING_INPUTS,
};
const purchase = (p: Partial<FundingInputs["purchase"]>): FundingInputs => ({
  ...DEFAULT_FUNDING_INPUTS,
  purchase: {
    ...DEFAULT_FUNDING_INPUTS.purchase,
    registrationMortgage: 150_000, scrivenerFee: 100_000, loanFeeFixed: 33_000, loanGuarantee: 600_000,
    fireInsurance: 50_000, acquisitionTax: 200_000, others: [{ label: "引越し費用", amount: 100_000 }], ...p,
  },
});
const sale = (s: Partial<FundingInputs["sale"]>): FundingInputs => ({
  ...DEFAULT_FUNDING_INPUTS, mode: "sale", sale: { ...DEFAULT_FUNDING_INPUTS.sale, ...s },
});
const run = (d: DealView, i: FundingInputs) => fundingPlanCalc(d, computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24"), i, rateRows);
const amount = (lines: { key: string; amount: number | null }[], key: string) => lines.find((l) => l.key === key)?.amount;

describe("資金計画表(購入)", () => {
  it("諸費用の行と合計(仲介手数料=税込・印紙・登記は取引の登記費用・精算金=買主が払う向き)", () => {
    const p = run(deal, purchase({})).purchase;
    expect(p.lines.map((l) => l.key)).toEqual([
      "brokerage", "stamp", "registrationTransfer", "registrationPreservation", "registrationMortgage", "scrivenerFee",
      "loanFee", "loanGuarantee", "fireInsurance", "settlement", "acquisitionTax", "other-0",
    ]);
    expect(amount(p.lines, "brokerage")).toBe(1_056_000);
    expect(amount(p.lines, "stamp")).toBe(10_000);
    expect(amount(p.lines, "registrationTransfer")).toBe(300_000);
    expect(amount(p.lines, "registrationPreservation")).toBeNull();
    expect(amount(p.lines, "settlement")).toBe(90_493);
    expect(p.costsTotal).toBe(2_689_493);
    expect(p.total).toBe(32_689_493);
  });

  it("印紙を折半にすると半分(切り捨て)", () => {
    const p = run(deal, { ...purchase({}), stampShare: "half" }).purchase;
    expect(amount(p.lines, "stamp")).toBe(5_000);
  });

  it("依頼書の例: 借入 4,000万円・年1.0%・35年 → 月 112,914円。区分は管理費・修繕積立金を足した月々の支払総額", () => {
    const p = run(deal, purchase({ loanAmount: 40_000_000, loans: [{ annualRateBp: 100, years: 35 }, { annualRateBp: 0, years: 35 }] })).purchase;
    expect(p.loanAmount).toBe(40_000_000);
    expect(p.loanSource).toBe("input");
    expect(p.loans[0]).toEqual({ annualRateBp: 100, years: 35, monthly: 112_914, monthlyTotal: 142_914 });
    expect(p.loans[1].monthly).toBe(95_238);
    expect(p.monthlyHousing).toBe(30_000);
    // 借入額が必要額を超えるときは知らせる(自己資金はマイナスで出す)。
    expect(p.ownFunds).toBe(32_689_493 - 40_000_000);
    expect(p.notes.join()).toContain("借入額が必要な資金の合計を超えています");
  });

  it("借入額が空なら 合計−自己資金(固定の事務手数料)。合計=自己資金+借入額", () => {
    const p = run(deal, purchase({ ownFunds: 5_000_000 })).purchase;
    expect(p.loanSource).toBe("ownFunds");
    expect(p.loanAmount).toBe(27_689_493);
    expect(p.ownFunds).toBe(5_000_000);
    expect((p.ownFunds ?? 0) + p.loanAmount).toBe(p.total);
  });

  it("定率の事務手数料は借入額×率(切り捨て)。自己資金から逆算するときは事務手数料を除いて決める", () => {
    const p = run(deal, purchase({ ownFunds: 5_000_000, loanFeeType: "rate", loanFeeRateBp: 220 })).purchase;
    expect(p.loanAmount).toBe(27_656_493);
    expect(amount(p.lines, "loanFee")).toBe(608_442);
    expect(p.total).toBe(33_264_935);
    expect(p.ownFunds).toBe(5_608_442);
    expect(p.notes.join()).toContain("事務手数料");
  });

  it("自己資金も借入額も空なら 借入額=物件価格", () => {
    const p = run(deal, purchase({})).purchase;
    expect(p.loanSource).toBe("price");
    expect(p.loanAmount).toBe(30_000_000);
  });

  it("土地: 保存登記・火災保険の行は出さず、月々の支払総額に管理費を足さない", () => {
    const p = run({ ...deal, propertyKind: "land" }, purchase({ loanAmount: 40_000_000 })).purchase;
    expect(p.lines.map((l) => l.key)).not.toContain("registrationPreservation");
    expect(p.lines.map((l) => l.key)).not.toContain("fireInsurance");
    expect(p.monthlyHousing).toBeNull();
    expect(p.loans[0].monthlyTotal).toBe(112_914);
  });

  it("決済日が無ければ精算金の行を出さず、理由を出す", () => {
    const p = run({ ...deal, settlementAt: null }, purchase({})).purchase;
    expect(p.lines.map((l) => l.key)).not.toContain("settlement");
    expect(p.notes.join()).toContain("決済日時");
  });

  it("売買価格が無ければ合計は出さない(空欄の理由を出す)", () => {
    const r = run({ ...deal, price: null }, purchase({}));
    expect(r.price).toBeNull();
    expect(r.missing).toContain("売買価格");
    expect(r.purchase.loans[0].monthly).toBe(0);
  });
});

describe("資金計画表(売却)", () => {
  it("費用(抹消は取引の抹消費用)・残債・精算金(受け取る向き)から手取り。依頼書の譲渡所得税の目安(長期・取得費不明=5%)", () => {
    const r = run(deal, sale({ loanBalance: 10_000_000, acquiredOn: "2015-03-01" }));
    const s = r.sale;
    expect(s.lines.map((l) => l.key)).toEqual(["brokerage", "stamp", "mortgageCancellation", "surveyFee"]);
    expect(amount(s.lines, "mortgageCancellation")).toBe(30_000);
    expect(amount(s.lines, "surveyFee")).toBeNull();
    expect(s.costsTotal).toBe(1_096_000);
    expect(s.settlementReceive).toBe(90_493);
    expect(s.netBeforeTax).toBe(18_994_493);
    expect(s.tax).toMatchObject({ longTerm: true, usedEstimatedCost: true, acquisitionCost: 1_500_000, taxable: 27_434_000, total: 5_573_200 });
    expect(s.netAfterTax).toBe(13_421_293);
    expect(s.taxNote).toBe("概算です。正確な税額は税理士にご確認ください。");
  });

  it("居住用の3,000万円控除を使うと税の目安は 0", () => {
    const s = run(deal, sale({ acquiredOn: "2015-03-01", residentialDeduction: true })).sale;
    expect(s.tax?.total).toBe(0);
  });

  it("取得日が無ければ税の目安は出さない(理由を出す)", () => {
    const s = run(deal, sale({})).sale;
    expect(s.tax).toBeNull();
    expect(s.netAfterTax).toBeNull();
    expect(s.notes.join()).toContain("取得日");
  });

  it("戸建は解体費の行がある・区分は無い", () => {
    expect(run({ ...deal, propertyKind: "house" }, sale({ demolitionFee: 2_000_000 })).sale.lines.map((l) => l.key)).toContain("demolitionFee");
    expect(run(deal, sale({ demolitionFee: 2_000_000 })).sale.lines.map((l) => l.key)).not.toContain("demolitionFee");
  });
});

describe("最終レビュー: OC の敷金・買取再販の手数料", () => {
  const oc: DealView = {
    ...deal, hasOc: true, settlementTerms: { ...deal.settlementTerms, depositMode: "offset" },
    leases: [{ room: "101", tenant: null, contractType: "ordinary", period: null, rent: 80_000, commonFee: 0, parking: 0, other: 0, deposit: 160_000, arrears: false, arrearsAmount: 0, manager: null }],
  };
  it("敷金を残代金と相殺するときは、購入の必要資金から引き、売却の手取りからも引く", () => {
    const r = run(oc, purchase({}));
    expect(amount(r.purchase.lines, "depositOffset")).toBe(-160_000);
    const s = run(oc, sale({})).sale;
    expect(s.depositOffset).toBe(160_000);
    const noDeposit = run({ ...oc, leases: [{ ...oc.leases[0], deposit: 0 }] }, sale({})).sale;
    expect(noDeposit.netBeforeTax! - s.netBeforeTax!).toBe(160_000);
  });
  it("別途授受のときは資金計画に入れない", () => {
    const sep = { ...oc, settlementTerms: { ...oc.settlementTerms, depositMode: "separate" as const } };
    expect(run(sep, purchase({})).purchase.lines.map((l) => l.key)).not.toContain("depositOffset");
    expect(run(sep, sale({})).sale.depositOffset).toBe(0);
  });
  it("買取再販の取引では仲介手数料の行を出さない", () => {
    const r = run({ ...deal, businessType: "resale", tradeSide: null }, purchase({}));
    expect(r.purchase.lines.map((l) => l.key)).not.toContain("brokerage");
    expect(r.sale.lines.map((l) => l.key)).not.toContain("brokerage");
  });
});

describe("@codex: 印紙税の表が当たらないときは知らせる", () => {
  it("表が無ければ購入・売却の両方に注記を出す(黙って 0 にしない)", () => {
    const noStamp = rateRows.filter((r) => r.kind !== "stamp_contract");
    const d = deal;
    const r = fundingPlanCalc(d, computeDealCalc(d, noStamp, DEFAULT_PROPERTY_KINDS, "2026-10-24"), purchase({}), noStamp);
    expect(amount(r.purchase.lines, "stamp")).toBeNull();
    expect(r.purchase.notes.join()).toContain("印紙税の表");
    expect(r.sale.notes.join()).toContain("印紙税の表");
  });
  it("表があれば注記は出さない", () => {
    expect(run(deal, purchase({})).purchase.notes.join()).not.toContain("印紙税の表");
  });
});
