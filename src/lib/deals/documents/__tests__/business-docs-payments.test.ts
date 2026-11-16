import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../../calc/deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BANK_ACCOUNT, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import { DEFAULT_FUNDING_INPUTS } from "../../funding-schema";
import { DEFAULT_BUSINESS_INPUTS } from "../../business-schema";
import { resolveDealSettings } from "../../settings";
import type { DealPartyView, DealView } from "../../view";
import type { CompanyProfile } from "@/lib/sales-sheet/company-profile-store";
import type { BusinessDocContext } from "../business/common";
import { businessDocOf } from "../registry";
import { checklistItemsOf } from "../business/checklist-doc";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子" });
const SELF_SELLER = party({ id: "p-self", role: "seller", name: "架空不動産株式会社", partyType: "corporation", isSelf: true });
const deal: DealView = {
  id: "d", dealNo: "2026-0010", name: "試験", businessType: "brokerage", tradeSide: "both", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション<b>", roomNo: "201", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, taxInputMode: "total", fixedAssetTax: 100_000, cityPlanningTax: 20_000, managementFee: 15_000, repairReserve: 5_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal, extra: Partial<BusinessDocContext> = {}): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"), settings: resolveDealSettings(null),
  company, rateRows, today: "2026-10-25", logo: null, seal: SEAL, ...extra,
});
const doc = (key: string) => businessDocOf(key)!;

// お金の受け渡し(2026-11-16)の払い方・口座が、書類の初期値に入る。
const ACC = { bankName: "見本銀行", branchName: "本店", accountType: "ordinary" as const, accountNumber: "1234567", accountHolder: "ミホン タロウ" };
const transfer = { method: "transfer" as const, account: ACC };
const cash = { method: "cash" as const, account: EMPTY_BANK_ACCOUNT };

describe("お金の受け渡し → 残金決済のご案内", () => {
  it("買主様: 残金が振込なら口座が振込先の初期値・未定なら今までどおり(売主が自社なら設定の口座)", () => {
    expect(doc("settlement_guide").defaults(ctx({ ...deal, payments: { balance: transfer } })).values.payee).toBe("見本銀行 本店 普通 1234567 名義 ミホン タロウ");
    expect(doc("settlement_guide").defaults(ctx()).values.payee).toBeNull();
    const settings = { ...resolveDealSettings(null), bankAccount: { ...ACC, bankName: "自社銀行" } };
    expect(doc("settlement_guide").defaults(ctx({ ...deal, parties: [SELF_SELLER, BUYER] }, { settings })).values.payee).toContain("自社銀行");
  });
  it("買主様: 振込で口座が空・売主が自社なら設定の口座", () => {
    const settings = { ...resolveDealSettings(null), bankAccount: { ...ACC, bankName: "自社銀行" } };
    const d = { ...deal, parties: [SELF_SELLER, BUYER], payments: { balance: { method: "transfer" as const, account: EMPTY_BANK_ACCOUNT } } };
    expect(doc("settlement_guide").defaults(ctx(d, { settings })).values.payee).toContain("自社銀行");
  });
  it("売主様: お受け取りの口座の初期値=残金の口座・現金なら現金・未定なら空", () => {
    expect(doc("settlement_guide_seller").defaults(ctx({ ...deal, payments: { balance: transfer } })).values.receiveTo).toBe("見本銀行 本店 普通 1234567 名義 ミホン タロウ");
    expect(doc("settlement_guide_seller").defaults(ctx({ ...deal, payments: { balance: cash } })).values.receiveTo).toBe("現金でお受け取りいただきます");
    expect(doc("settlement_guide_seller").defaults(ctx()).values.receiveTo).toBeNull();
  });
  it("出した書類にも振込先が載る", () => {
    const c = ctx({ ...deal, payments: { balance: transfer } });
    const out = doc("settlement_guide").build(c, doc("settlement_guide").defaults(c).values);
    expect(out.html).toContain("見本銀行 本店 普通 1234567");
  });
});

describe("お金の受け渡し → 書類確認書", () => {
  it("持参する金額の払い方の初期値に、手付金・残金の払い方が入る(未定は空)", () => {
    const d = { ...deal, payments: { deposit: cash, balance: transfer } };
    const c = ctx(d);
    for (const [key, phase] of [["checklist_contract", "contract"], ["checklist_settlement", "settlement"]] as const) {
      const pay = doc(key).defaults(c).values.pay as Record<string, { method: string }[]>;
      const items = checklistItemsOf(phase, c).filter((x) => x.amount !== null);
      expect(items.some((x) => x.amount === (phase === "contract" ? "deposit" : "payment"))).toBe(true);
      for (const i of items) {
        const want = i.amount === "deposit" ? ["cash"] : i.amount === "payment" ? ["transfer"] : [];
        expect(pay[i.id].map((e) => e.method)).toEqual(want);
      }
    }
    const empty = doc("checklist_settlement").defaults(ctx()).values.pay as Record<string, unknown[]>;
    expect(Object.values(empty).every((v) => v.length === 0)).toBe(true);
  });
});
