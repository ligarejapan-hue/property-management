import { describe, expect, it } from "vitest";
import { renderFundingPlanHtml } from "../funding-plan";
import { fundingPlanCalc } from "../../calc/funding-plan";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS, type FundingInputs } from "../../funding-schema";
import type { DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-05-01T01:00:00.000Z", contractPlace: null, settlementAt: "2026-07-01T01:00:00.000Z", settlementPlace: null,
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション<b>", roomNo: "101", address: "架空県架空市1-2-3" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, managementFee: 20_000, repairReserve: 10_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [], fundingPlan: DEFAULT_FUNDING_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空知事(1)第00000号", tel: "000-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市" };
const render = (i: FundingInputs, d: DealView = deal) =>
  renderFundingPlanHtml({ deal: d, inputs: i, calc: fundingPlanCalc(d, computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24"), i, rateRows), company, issuedOn: "2026-10-24" });

describe("資金計画表の HTML", () => {
  const purchase: FundingInputs = {
    ...DEFAULT_FUNDING_INPUTS, customerName: `架空 "太郎" <script>alert(1)</script>`,
    purchase: { ...DEFAULT_FUNDING_INPUTS.purchase, loanAmount: 40_000_000, scrivenerFee: 100_000, loans: [{ annualRateBp: 100, years: 35 }, { annualRateBp: 150, years: 30 }] },
  };

  it("A4 縦の1枚の文書で、外の URL を読まない", () => {
    const h = render(purchase);
    expect(h.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(h).toContain("size: A4 portrait");
    expect(h).not.toMatch(/https?:\/\//);
    expect(h).toContain("BIZ UDGothic");
  });

  it("お客様名・物件名は無害化して出す", () => {
    const h = render(purchase);
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("試験マンション&lt;b&gt; 101");
    expect(h).toContain("架空不動産株式会社");
  });

  it("購入: 諸費用・合計・借入額・ローンの比較(月返済額と月々の支払総額)", () => {
    const h = render(purchase);
    expect(h).toContain("資金計画表(ご購入)");
    expect(h).toContain("司法書士報酬");
    expect(h).toContain("40,000,000");
    expect(h).toContain("112,914");
    expect(h).toContain("142,914");
    expect(h).toContain("年1.5%");
    // 空欄の諸費用の行(火災保険など)は出さない。
    expect(h).not.toContain("火災保険");
    expect(h).not.toContain("譲渡所得");
  });

  it("売却: 手取りと譲渡所得税の目安(注記は必ず)", () => {
    const h = render({ ...purchase, mode: "sale", sale: { ...DEFAULT_FUNDING_INPUTS.sale, loanBalance: 10_000_000, acquiredOn: "2015-03-01" } });
    expect(h).toContain("資金計画表(ご売却)");
    expect(h).toContain("手取り額");
    expect(h).toContain("譲渡所得税");
    expect(h).toContain("概算です。正確な税額は税理士にご確認ください。");
    expect(h).not.toContain("ローンの比較");
  });

  it("売却で取得日が無くても、注記と理由を出す", () => {
    const h = render({ ...purchase, mode: "sale" });
    expect(h).toContain("概算です。正確な税額は税理士にご確認ください。");
    expect(h).toContain("取得日を入れると出ます");
  });

  it("売買価格が無ければ金額の欄は「—」", () => {
    const h = render(purchase, { ...deal, price: null });
    expect(h).toContain("—");
  });
});
