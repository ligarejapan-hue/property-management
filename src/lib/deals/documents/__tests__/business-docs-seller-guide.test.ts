import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { BUSINESS_DOCS, businessDocOf } from "../registry";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const AGENT = party({ id: "p-agent", role: "agent", name: "架空 次郎", address: "架空県架空市5-5" });
const deal: DealView = {
  id: "d", dealNo: "2026-0011", name: "試験", businessType: "resale", tradeSide: null, status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "building", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 50_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, cityPlanningTax: 20_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER, AGENT],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"),
  settings: { ...resolveDealSettings(null), bankAccount: { bankName: "架空銀行", branchName: "本店", accountType: "ordinary", accountNumber: "1234567", accountHolder: "カクウフドウサン" } },
  company, rateRows, today: "2026-10-25", logo: null, seal: SEAL,
});
const doc = (key: string) => businessDocOf(key)!;
const KEY = "settlement_guide_seller";
const brokerDeal: DealView = {
  ...deal, businessType: "brokerage", tradeSide: "seller",
  costs: { ...DEFAULT_COSTS, cancellationFee: 50_000, surveyFee: 300_000, others: [{ label: "引越し費用", amount: 100_000 }] },
};

describe("残金決済のご案内(売主様)", () => {
  it("決済の書類の、買主あてのご案内のすぐ後ろに出る", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(KEY)).toBe(keys.indexOf("settlement_guide") + 1);
    expect(doc(KEY).label).toBe("残金決済のご案内(売主様)");
    expect(doc(KEY).group).toBe("settlement");
    expect(doc(KEY).applies(ctx())).toBe(true);
  });

  it("諸費用の初期値は取引の費用(仲介手数料は売主側・両手の仲介だけ)", () => {
    const c = ctx(brokerDeal);
    const fee = c.calc.brokerage!.incl;
    expect(fee).toBeGreaterThan(0);
    expect(doc(KEY).defaults(c).values.costs).toEqual([
      { label: "仲介手数料(税込)", amount: fee }, { label: "抵当権などの抹消費用", amount: 50_000 },
      { label: "測量費", amount: 300_000 }, { label: "引越し費用", amount: 100_000 },
    ]);
    // 買主側の仲介・買取再販では仲介手数料を入れない
    expect((doc(KEY).defaults(ctx({ ...brokerDeal, tradeSide: "buyer" })).values.costs as { label: string }[]).map((r) => r.label)).not.toContain("仲介手数料(税込)");
    expect(doc(KEY).defaults(ctx()).values.costs).toEqual([]);
  });

  it("残代金+精算金−諸費用=当日のお受取額(決済時のお支払額から諸費用を引く)", () => {
    const c = ctx(brokerDeal);
    const costs = [{ label: "抵当権などの抹消費用", amount: 50_000 }, { label: "測量費", amount: 300_000 }];
    const out = doc(KEY).build(c, { costs, receiveTo: null, belongings: null });
    const pay = c.calc.settlement.paymentAtSettlement!;
    const net = pay - 350_000;
    expect(out.html).toContain("架空 一郎 様");
    expect(out.html).toContain("諸費用");
    expect(out.html).toContain("測量費");
    expect(out.html).toContain(`${net.toLocaleString("ja-JP")}円`);
    expect(out.rows).toContainEqual({ label: "当日のお受取額", value: net });
    expect(out.rows).toContainEqual({ label: "諸費用の合計", value: 350_000 });
  });

  it("出す前の確認と、選ぶものの形(諸費用の行は20行まで・金額は0以上の整数)", () => {
    expect(doc(KEY).missing(ctx({ ...deal, settlementPlace: null, parties: [] }))).toEqual(["決済場所", "売主"]);
    const o = doc(KEY).options;
    expect(() => o.parse({ costs: [{ label: "x", amount: -1 }], receiveTo: null, belongings: null })).toThrow();
    expect(() => o.parse({ costs: [{ label: "x", amount: 1.5 }], receiveTo: null, belongings: null })).toThrow();
    expect(() => o.parse({ costs: Array.from({ length: 21 }, () => ({ label: "x", amount: 1 })), receiveTo: null, belongings: null })).toThrow();
    expect(o.parse({ costs: [], receiveTo: null, belongings: null })).toEqual({ costs: [], receiveTo: null, belongings: null });
  });
});
