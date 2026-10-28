import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SALE_GUIDE } from "../texts/sale-guide";
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
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const SELLER = party({ id: "s", role: "seller", name: "架空 一郎<i>", address: "架空県架空市1-1" });
const BUYER = party({ id: "b", role: "buyer", name: "架空 花子", address: "架空県架空市4-4" });
const deal: DealView = {
  id: "d", dealNo: "2026-0051", name: "試験", businessType: "brokerage", tradeSide: "seller", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "house", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null,
  price: 30_000_000, buildingTax: 1_000_000, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハウス<b>", address: "架空県架空市2-2", lotNumber: "2番2", landArea: 120.5, floorArea: 95.2, structure: "木造2階建", layout: "4LDK", landRight: "ownership" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const settings = { ...resolveDealSettings(null), representativeTitle: "代表取締役", representativeName: "架空 太郎" };
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings, company, rateRows, today: "2026-10-28", logo: null, seal: "data:image/png;base64,c2VhbA==",
  staff: { sales: "架空 営業", ops: null },
});
describe("媒介契約の前の説明書(売却用・第2段階 §4.6)", () => {
  it("写した文面の指紋とどこから写したか", () => {
    expect(SALE_GUIDE.source).toBe("178_baikaijizen_baikyaku-1.docx");
    expect(SALE_GUIDE.title).toBe("不動産の売却を検討される皆様へ（売却の媒介委託者用）");
    expect(SALE_GUIDE.intro[0]).toContain("当事者の間に立って");
    expect(SALE_GUIDE.related).toContain("ⅳ　表示に関する登記に関する権利調査等");
    const h = createHash("sha256").update(JSON.stringify([SALE_GUIDE.title, SALE_GUIDE.intro, SALE_GUIDE.flowTitle, SALE_GUIDE.sale, SALE_GUIDE.related])).digest("hex");
    expect(h).toBe("4882efb4ac36ccc91bb58c39d65ee57cb9778ac88dd12884a50d347d8d9418b3");
  });
  it("媒介契約書の次・売主側か両手の仲介だけ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf("sale_guide")).toBe(keys.indexOf("mediation") + 1);
    expect(businessDocOf("sale_guide")!.label).toBe("媒介契約の前の説明書(売却用)");
    expect(businessDocOf("sale_guide")!.group).toBe("contract");
    expect(businessDocOf("sale_guide")!.applies(ctx())).toBe(true);
    expect(businessDocOf("sale_guide")!.applies(ctx({ ...deal, tradeSide: "both" }))).toBe(true);
    expect(businessDocOf("sale_guide")!.applies(ctx({ ...deal, tradeSide: "buyer" }))).toBe(false);
    expect(businessDocOf("sale_guide")!.applies(ctx({ ...deal, businessType: "resale", tradeSide: null }))).toBe(false);
    expect(dealDocumentTitle("sale_guide", "default")).toBe("媒介契約の前の説明書(売却用)");
  });
  it("1ページで文面をそのまま・会社名と担当者を添える", () => {
    const h = businessDocOf("sale_guide")!.build(ctx(), {}).html;
    for (const p of [...SALE_GUIDE.intro, ...SALE_GUIDE.sale, ...SALE_GUIDE.related]) expect(h, p).toContain(p);
    expect(h).toContain("架空不動産株式会社");
    expect(h).toContain("担当 架空 営業");
  });
});
