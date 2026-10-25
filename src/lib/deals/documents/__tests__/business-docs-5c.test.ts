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
  settlementTerms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, cityPlanningTax: 20_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER, AGENT],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const OC: DealView = {
  ...deal, hasOc: true,
  leases: [lease({}), lease({ room: "102", tenant: null, rent: 0, commonFee: 0, deposit: 0 }), lease({ room: "201", tenant: "架空 四郎", arrears: true, arrearsAmount: 80_000 })],
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"),
  settings: { ...resolveDealSettings(null), bankAccount: { bankName: "架空銀行", branchName: "本店", accountType: "ordinary", accountNumber: "1234567", accountHolder: "カクウフドウサン" } },
  company, rateRows, today: "2026-10-25", logo: null, seal: SEAL,
});
const doc = (key: string) => businessDocOf(key)!;
const CL = ["checklist_contract", "checklist_settlement"];
const withStaff = (d: DealView = deal): BusinessDocContext => ({ ...ctx(d), staff: { sales: "架空 営業", ops: "架空 業務" } });
const unitDeal: DealView = {
  ...deal, propertyKind: "unit",
  counterpartyBroker: { company: "架空仲介", staff: "架空 担当", tel: "03-1111-1111" },
  costs: { ...DEFAULT_COSTS, scrivener: { name: "架空司法書士事務所", address: null, tel: "03-2222-2222", staff: "架空 書士" }, registrationFee: 300_000 },
};

describe("書類確認書(段5c-1)", () => {
  it("一覧表の最後に2つ・まとまりは書類確認書・どの取引でも出る", () => {
    expect(BUSINESS_DOCS.map((d) => d.key).slice(-2)).toEqual(CL);
    for (const k of CL) {
      expect(doc(k).group).toBe("checklist");
      expect(doc(k).applies(ctx())).toBe(true);
      expect(doc(k).blocking(ctx())).toEqual([]);
    }
    expect(doc("checklist_contract").label).toBe("書類確認書(契約時)");
    expect(doc("checklist_settlement").label).toBe("書類確認書(決済時)");
  });

  it("頭に取引番号・物件・売主買主・日時場所・相手方の仲介・司法書士・営業担当と業務担当", () => {
    const h = doc("checklist_settlement").build(withStaff(unitDeal), { pay: {} }).html;
    for (const s of ["2026-0011", "試験ハイツ&lt;b&gt;", "架空 一郎", "架空 花子", "架空銀行 架空支店", "架空仲介", "03-1111-1111", "架空司法書士事務所", "架空 書士", "架空 営業", "架空 業務"]) {
      expect(h).toContain(s);
    }
    expect(h).not.toContain("<b>");
  });

  it("3つのまとまり・承認欄・区分の項目は区分だけに出る・リースバックは無い", () => {
    const unit = doc("checklist_contract").build(ctx(unitDeal), { pay: {} }).html;
    for (const s of ["事前に手配・確認するもの", "持参するもの", "受け取るもの", "承認", "管理規約・重要事項調査報告書の取得"]) expect(unit).toContain(s);
    expect(unit).not.toContain("境界・越境の確認");
    const bldg = doc("checklist_contract").build(ctx(), { pay: {} }).html;
    expect(bldg).toContain("境界・越境の確認");
    expect(bldg).not.toContain("管理規約・重要事項調査報告書の取得");
    expect(bldg).not.toContain("賃貸借契約書・賃借人一覧の確認");
    expect(doc("checklist_contract").build(ctx(OC), { pay: {} }).html).toContain("賃貸借契約書・賃借人一覧の確認");
    expect(unit + bldg).not.toMatch(/リースバック/);
  });

  it("持参する金額は決済の計算と取引の値・払い方は選んだもの(初めは現金)", () => {
    const c = ctx(unitDeal);
    const def = doc("checklist_settlement").defaults(c);
    expect(def.values).toEqual({ pay: { s_bring_payment: "cash", s_bring_registration: "cash" } });
    expect(def.choices!.payMethods.map((x) => x.value)).toEqual(["cash", "from_deposit", "from_balance"]);
    expect(def.choices!.payItems.map((x) => x.value)).toEqual(["s_bring_payment", "s_bring_registration"]);
    const out = doc("checklist_settlement").build(c, { pay: { s_bring_payment: "from_balance" } });
    const pay = c.calc.settlement.paymentAtSettlement!;
    expect(pay).toBeGreaterThan(0);
    expect(out.html).toContain(`${pay.toLocaleString("ja-JP")}円`);
    expect(out.html).toContain("300,000円");
    expect(out.html).toContain("残金から");
    expect(out.rows).toContainEqual({ label: "持参: 残代金・精算金", value: pay });
    expect(doc("checklist_contract").build(c, { pay: {} }).html).toContain("2,000,000円");
  });

  it("出す前の確認: 日時・売主・買主・金額が無い持参の項目", () => {
    const empty: DealView = { ...deal, contractAt: null, deposit: null, parties: [] };
    expect(doc("checklist_contract").missing(ctx(empty))).toEqual(["契約日時", "売主", "買主", "手付金"]);
    expect(doc("checklist_settlement").missing(ctx(unitDeal))).toEqual([]);
    expect(doc("checklist_settlement").missing(ctx())).toEqual(["登記費用"]);
  });

  it("払い方の形: 知らない払い方は通さない", () => {
    expect(() => doc("checklist_settlement").options.parse({ pay: { s_bring_payment: "card" } })).toThrow();
    expect(() => doc("checklist_settlement").options.parse({ pay: { "Bad Id": "cash" } })).toThrow();
    expect(doc("checklist_settlement").options.parse({ pay: {} })).toEqual({ pay: {} });
  });

  it("担当者の名前が無いときは「—」", () => {
    const h = doc("checklist_contract").build(ctx(), { pay: {} }).html;
    expect(h).toMatch(/営業担当<\/th><td>—/);
  });
});
