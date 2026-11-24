import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT, type Lease } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { businessDocOf } from "../registry";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const AGENT = party({ id: "p-agent", role: "agent", name: "架空 次郎", address: "架空県架空市5-5" });
const lease = (l: Partial<Lease>): Lease => ({
  room: "101", tenant: "架空 三郎", contractType: "ordinary", period: "2025-04〜2027-03", rent: 80_000, commonFee: 5_000, parking: 0, other: 0,
  deposit: 160_000, arrears: false, arrearsAmount: 0, manager: "架空管理", ...l,
});
const deal: DealView = {
  id: "d", dealNo: "2026-0011", name: "試験", businessType: "resale", tradeSide: null, status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "building", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 50_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, taxInputMode: "total", fixedAssetTax: 100_000, cityPlanningTax: 20_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER, AGENT],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const OC: DealView = {
  ...deal, hasOc: true,
  leases: [lease({}), lease({ room: "102", tenant: null, rent: 0, commonFee: 0, deposit: 0 }), lease({ room: "201", tenant: "架空 四郎", arrears: true, arrearsAmount: 80_000 })],
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"),
  settings: { ...resolveDealSettings(null), bankAccount: { bankName: "架空銀行", branchName: "本店", accountType: "ordinary", accountNumber: "1234567", accountHolder: "カクウフドウサン" } },
  company, rateRows, today: "2026-10-25", logo: null, seal: null,
});
const doc = (key: string) => businessDocOf(key)!;
const SELLER2 = party({ id: "p-seller2", role: "seller", name: "架空 五郎", address: "架空県架空市6-6", sortOrder: 1 });
const TWO = { ...OC, parties: [SELLER, SELLER2, BUYER, AGENT] };
const build = (key: string, extra: Record<string, unknown> = {}) => {
  const c = ctx(TWO);
  return doc(key).build(c, { ...doc(key).defaults(c).values, ...extra }).html;
};
const SELLERS = "架空 一郎 様・架空 五郎 様";
const BUYERS = "架空 花子 様";

// 2026-11-24 発注者「精算書の売主・買主名に様が入っていない」→ お客様に渡す書類と社内用の書類の名前に1人ずつ「様」を付ける。
describe("売主・買主の名前に様を付ける", () => {
  it.each(["settlement_statement", "checklist_contract", "checklist_settlement", "handover_checklist", "prep_checklist", "completion_confirmation"])(
    "%s は売主・買主とも1人ずつ様が付く", (key) => {
      const h = build(key);
      expect(h).toContain(SELLERS);
      expect(h).toContain(BUYERS);
    });
  it("賃貸人変更のお知らせの新しい賃貸人に様が付く", () => {
    expect(build("landlord_change_notice")).toContain(`<td>${BUYERS}</td>`);
  });
  it("売主属性調査書の売主の名前に様が付く", () => {
    const h = build("seller_survey");
    expect(h).toContain("<td>架空 一郎 様</td>");
    expect(h).toContain("<td>架空 五郎 様</td>");
  });
  it("宛名の行も2人なら1人ずつ様が付く", () => {
    expect(build("contract_guide", { addressee: "seller" })).toContain(`<div class="customer">${SELLERS}</div>`);
    expect(build("settlement_guide_seller")).toContain(`<div class="customer">${SELLERS}</div>`);
    expect(build("settlement_guide")).toContain(`<div class="customer">${BUYERS}</div>`);
    expect(build("key_receipt")).toContain(`<div class="customer">${SELLERS}</div>`);
  });
  it("契約・委任の署名の欄には様を付けない", () => {
    const h = build("completion_confirmation");
    expect(h).toContain("氏名 架空 一郎</td>");
    expect(h).not.toContain("氏名 架空 一郎 様");
    const m = build("mediation");
    expect(m).toContain("氏名 架空 一郎");
    expect(m).not.toContain("架空 一郎 様");
  });
});
