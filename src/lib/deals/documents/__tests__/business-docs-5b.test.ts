import { describe, expect, it } from "vitest";
import { computeDealCalc } from "../../calc/deal-calc";
import { businessPlanCalc } from "../../calc/business-plan";
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
import { DocOptionError } from "../business/receipts";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "p-seller", role: "seller", name: "架空 一郎", address: "架空県架空市1-1" });
const BUYER = party({ id: "p-buyer", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const SELF_BUYER = party({ id: "p-self", role: "buyer", name: "架空不動産株式会社", partyType: "corporation", isSelf: true });
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
const SEAL = "data:image/png;base64,c2VhbA==";
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"),
  settings: { ...resolveDealSettings(null), bankAccount: { bankName: "架空銀行", branchName: "本店", accountType: "ordinary", accountNumber: "1234567", accountHolder: "カクウフドウサン" } },
  company, rateRows, today: "2026-10-25", logo: null, seal: SEAL,
});
const doc = (key: string) => businessDocOf(key)!;
const OC_KEYS = ["oc_purchase_consult", "tenant_survey", "landlord_change_notice", "handover_checklist"];

describe("一覧表(段5b)", () => {
  it("委任状・鍵受領書・OC の4種が足され、まとまりを持つ", () => {
    expect(BUSINESS_DOCS.map((d) => d.key)).toEqual([
      "contract_guide", "seller_survey", "mediation", "sale_guide", "settlement_statement", "settlement_guide", "settlement_guide_seller", "deposit_receipt", "balance_receipt", "settlement_receipt", "completion_confirmation",
      "power_of_attorney", "key_receipt", ...OC_KEYS, "checklist_contract", "checklist_settlement", "prep_checklist",
    ]);
    expect(doc("power_of_attorney").group).toBe("other");
    expect(doc("settlement_statement").group).toBe("settlement");
    for (const k of OC_KEYS) expect(doc(k).group).toBe("oc");
  });
  it("OC の4種は OC なしの取引に出ない", () => {
    for (const k of OC_KEYS) {
      expect(doc(k).applies(ctx())).toBe(false);
      expect(doc(k).applies(ctx(OC))).toBe(true);
    }
    expect(doc("power_of_attorney").applies(ctx())).toBe(true);
    expect(doc("key_receipt").applies(ctx())).toBe(true);
  });
});

describe("委任状", () => {
  const opts = { principal: "p-seller", agent: "self", matters: ["valuation_cert", "receive_balance"], otherMatter: "固定資産税の精算", signedOn: null };
  it("委任者は自社でない売主・買主、受任者は自社と代理人。初期値は最初の売主と自社", () => {
    const d = doc("power_of_attorney").defaults(ctx({ ...deal, parties: [SELLER, BUYER, AGENT, SELF_BUYER] }));
    expect(d.choices?.principal.map((x) => x.value)).toEqual(["p-seller", "p-buyer"]);
    expect(d.choices?.agent.map((x) => x.value)).toEqual(["self", "p-agent"]);
    expect(d.values).toMatchObject({ principal: "p-seller", agent: "self", matters: [], otherMatter: null, signedOn: null });
  });
  it("受任者・委任内容・委任者を出し、署名・実印の欄は空欄で角印は付けない", () => {
    const { html, rows } = doc("power_of_attorney").build(ctx(), opts);
    expect(html).toContain("委任状");
    expect(html).toContain("架空不動産株式会社");
    expect(html).toContain("固定資産評価証明書の取得");
    expect(html).toContain("残代金の受領");
    expect(html).not.toContain("鍵の受け渡し");
    expect(html).toContain("固定資産税の精算");
    expect(html).toContain("架空 一郎");
    expect(html).toContain("署名・実印");
    expect(html).not.toContain(SEAL);
    expect(html).toContain("BIZ UDMincho");
    expect(html).toContain("試験ハイツ&lt;b&gt;");
    expect(rows.find((r) => r.label === "委任者")?.value).toBe("架空 一郎");
  });
  it("代理人の当事者を受任者にできる", () => {
    expect(doc("power_of_attorney").build(ctx(), { ...opts, agent: "p-agent" }).html).toContain("架空 次郎");
  });
  it("自社・当事者でない ID・代理人を委任者に選べない。委任内容が無ければ出せない", () => {
    const c = ctx({ ...deal, parties: [SELLER, BUYER, AGENT, SELF_BUYER] });
    for (const principal of ["p-self", "p-agent", "nobody"]) {
      expect(() => doc("power_of_attorney").build(c, { ...opts, principal })).toThrow(DocOptionError);
    }
    expect(() => doc("power_of_attorney").build(c, { ...opts, agent: "p-seller" })).toThrow(DocOptionError);
    expect(() => doc("power_of_attorney").build(c, { ...opts, matters: [], otherMatter: null })).toThrow(DocOptionError);
  });
  it("委任する人がいなければ止める項目に出す", () => {
    expect(doc("power_of_attorney").blocking(ctx({ ...deal, parties: [SELF_BUYER] }))).toEqual(["委任する人(売主・買主)"]);
    expect(doc("power_of_attorney").blocking(ctx())).toEqual([]);
  });
});

describe("鍵受領書", () => {
  const opts = { receiver: "p-buyer", keys: [{ label: "玄関 No.12", count: 3 }, { label: "郵便受け", count: 1 }], receivedOn: "2026-06-30" };
  it("宛先は売主、鍵の行と合計、受領者の署名・押印の欄は空欄", () => {
    const { html, rows } = doc("key_receipt").build(ctx(), opts);
    expect(html).toContain("鍵受領書");
    expect(html).toContain("架空 一郎 様");
    expect(html).toContain("玄関 No.12");
    expect(html).toContain("合計 4本");
    expect(html).toContain("2026年6月30日");
    expect(html).toContain("架空 花子");
    expect(html).toContain("署名・押印");
    expect(html).not.toContain(SEAL);
    expect(rows.find((r) => r.label === "受領者")?.value).toBe("架空 花子");
  });
  it("受領者は自社と自社でない買主。自社の買主がいれば初期値は自社", () => {
    const d = doc("key_receipt").defaults(ctx({ ...deal, parties: [SELLER, BUYER, SELF_BUYER] }));
    expect(d.choices?.receiver.map((x) => x.value)).toEqual(["self", "p-buyer"]);
    expect(d.values.receiver).toBe("self");
    expect(doc("key_receipt").defaults(ctx()).values.receiver).toBe("p-buyer");
  });
  it("自社の受領でも角印は付けない。売主・鍵の行が無い・選べない受領者は出せない", () => {
    expect(doc("key_receipt").build(ctx(), { ...opts, receiver: "self" }).html).not.toContain(SEAL);
    expect(() => doc("key_receipt").build(ctx(), { ...opts, keys: [] })).toThrow(DocOptionError);
    expect(() => doc("key_receipt").build(ctx(), { ...opts, receiver: "p-seller" })).toThrow(DocOptionError);
  });
});

describe("OC の書類", () => {
  it("仕入相談表: 利回り・NOI は事業計画書と同じ値。賃借人の名前は出さず入居中/空室だけ", () => {
    const c = ctx(OC);
    const oc = businessPlanCalc(OC, c.calc, OC.businessPlan, rateRows).oc!;
    const { html, rows } = doc("oc_purchase_consult").build(c, {});
    expect(html).toContain("仕入相談表");
    expect(html).toContain(`${(oc.grossYieldBp! / 100).toFixed(2)}%`);
    expect(rows.find((r) => r.label === "NOI(年)")?.value).toBe(oc.noi);
    expect(rows.find((r) => r.label === "年間収入")?.value).toBe(oc.annualIncome);
    expect(html).toContain("入居中");
    expect(html).toContain("空室");
    expect(html).toContain("2/3室");
    expect(html).not.toContain("架空 三郎");
    expect(doc("oc_purchase_consult").missing(ctx({ ...OC, price: null, leases: [] }))).toEqual(["売買価格", "賃貸条件"]);
  });
  it("賃借人属性調査書: 賃借人のいる部屋ごとの欄に賃貸条件と手で書く欄(反社会的勢力の確認を含む)", () => {
    const { html } = doc("tenant_survey").build(ctx(OC), {});
    expect(html).toContain("賃借人属性調査書");
    expect(html).toContain("架空 三郎");
    expect(html).toContain("反社会的勢力");
    expect(html).toContain("□該当なし");
    expect(html.match(/class="tenant"/g)?.length).toBe(2);
    expect(doc("tenant_survey").blocking(ctx({ ...OC, leases: [lease({ tenant: null })] }))).toEqual(["賃借人(賃貸条件)"]);
  });
  it("賃貸人変更のお知らせ: 賃借人のいる部屋ごとに1枚(空室は出さない)・新賃貸人=買主・連名の押印欄は空欄", () => {
    const opts = { changeOn: "2026-06-30", payee: "架空銀行 本店 普通 1234567" };
    const { html } = doc("landlord_change_notice").build(ctx(OC), opts);
    expect(html.match(/page-break-before:always/g)?.length).toBe(1);
    expect(html).toContain("101 架空 三郎 様");
    expect(html).toContain("201 架空 四郎 様");
    expect(html).not.toContain("102");
    expect(html).toContain("2026年6月30日");
    expect(html).toContain("架空銀行 本店 普通 1234567");
    expect(html).toContain("旧賃貸人");
    expect(html).toContain("新賃貸人");
    expect(html).not.toContain(SEAL);
    expect(html).toContain("BIZ UDMincho");
  });
  it("お知らせの初期値: 変更日=決済日、振込先は買主が自社なら設定の口座。賃借人がいなければ止める", () => {
    expect(doc("landlord_change_notice").defaults(ctx(OC)).values).toEqual({ changeOn: "2026-06-30", payee: null });
    expect(doc("landlord_change_notice").defaults(ctx({ ...OC, parties: [SELLER, SELF_BUYER] })).values.payee).toContain("架空銀行");
    expect(doc("landlord_change_notice").blocking(ctx({ ...OC, leases: [lease({ tenant: null })] }))).toEqual(["賃借人(賃貸条件)"]);
  });
  it("引継書類チェックリスト: 部屋ごとの契約書原本・鍵・敷金と全体の項目、敷金の合計と扱い", () => {
    const { html, rows } = doc("handover_checklist").build(ctx(OC), {});
    expect(html).toContain("引継書類チェックリスト");
    expect(html).toContain("賃貸借契約書(原本)");
    expect(html).toContain("管理会社への連絡");
    expect(html).toContain("架空管理");
    expect(html).toContain("残代金と相殺");
    expect(rows.find((r) => r.label === "預り敷金の合計")?.value).toBe(320_000);
  });
});
