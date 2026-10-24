import { describe, expect, it } from "vitest";
import { buildBusinessPlan } from "../business-plan";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS, type BusinessInputs } from "../../business-schema";
import { resolveSectionMatrix } from "../../business-sections";
import type { DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const deal: DealView = {
  id: "d", dealNo: "2026-0009", name: "試験", businessType: "resale", tradeSide: null, status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-05-31T15:00:00.000Z", settlementPlace: null,
  price: 20_000_000, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション<b>", roomNo: "301", address: "架空県架空市1-2-3", floorArea: 60.5, builtYear: 2001, builtMonth: 4, access: "架空線 架空駅 徒歩5分" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS, settlementTerms: DEFAULT_TERMS,
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "", fax: "", email: "", hp: "", address: "" };
const inputs: BusinessInputs = {
  ...DEFAULT_BUSINESS_INPUTS, salePrice: 28_000_000, saleDate: "2026-11-30", loanAmount: 18_000_000, interiorCost: 3_000_000,
  memo: "社内だけの<メモ>", ownFunds: 5_000_000, loanMonths: 12,
  comparables: [{ kind: "sold", name: "近くの架空マンション", area: 58.2, price: 27_000_000, period: "2026年8月", note: null }],
};
const build = (i: BusinessInputs = inputs, d: DealView = deal, matrix = resolveSectionMatrix(undefined, DEFAULT_PROPERTY_KINDS)) =>
  buildBusinessPlan({ deal: d, rateRows, kinds: DEFAULT_PROPERTY_KINDS, matrix, inputs: i, company, today: "2026-10-24", logo: null });

describe("事業計画書の HTML", () => {
  it("社内用: 承認欄(担当・上長・決裁者)と社内メモがある・銀行向けだけのセクションは無い", () => {
    const { html, sections } = build();
    expect(html).toContain("事業計画書(社内用)");
    for (const s of ["担当", "上長", "決裁者"]) expect(html).toContain(`<th>${s}</th>`);
    expect(html).toContain("社内だけの&lt;メモ&gt;");
    expect(sections).not.toContain("financing");
    expect(html).not.toContain("<h2>資金計画</h2>");
    expect(html).not.toContain("<h2>販売価格の根拠</h2>");
  });
  it("銀行向け: 承認欄・社内メモを出さない・資金計画と販売価格の根拠を出す", () => {
    const { html } = build({ ...inputs, variant: "bank" });
    expect(html).toContain("事業計画書(銀行向け)");
    expect(html).not.toContain("決裁者");
    expect(html).not.toContain("社内だけの");
    expect(html).not.toContain("社内メモ");
    expect(html).toContain("<h2>資金計画</h2>");
    expect(html).toContain("期限一括返済");
    expect(html).toContain("<h2>販売価格の根拠</h2>");
    expect(html).toContain("近くの架空マンション");
  });
  it("表でオフにしたセクションは出さない", () => {
    const m = resolveSectionMatrix({ unit: { renovation: false } }, DEFAULT_PROPERTY_KINDS);
    const { html } = build(inputs, deal, m);
    expect(html).not.toContain("<h2>改装・工事</h2>");
    expect(html).toContain("<h2>保有コスト</h2>");
  });
  it("OC ありのときだけ OC収支", () => {
    expect(build().html).not.toContain("<h2>OC収支</h2>");
    expect(build(inputs, { ...deal, hasOc: true }).html).toContain("<h2>OC収支</h2>");
  });
  it("物件概要・収支の数字・利益率を出す・無害化する", () => {
    const { html, calc } = build();
    expect(html).toContain("試験マンション&lt;b&gt; 301");
    expect(html).toContain("架空県架空市1-2-3");
    expect(html).toContain("2001年4月");
    expect(html).toContain("60.5㎡");
    expect(html).toContain(`${(calc.profit.marginBp! / 100).toFixed(2)}%`);
    expect(html).toContain("損益分岐の販売価格");
  });
  it("値が無いときは「—」(undefined・NaN を出さない)・外の URL を読まない", () => {
    const { html } = build({ ...DEFAULT_BUSINESS_INPUTS }, { ...deal, price: null, settlementAt: null, propertySnapshot: EMPTY_SNAPSHOT });
    expect(html).not.toMatch(/undefined|NaN|null/);
    expect(html).toContain("—");
    expect(html).not.toMatch(/https?:\/\//);
  });
});
