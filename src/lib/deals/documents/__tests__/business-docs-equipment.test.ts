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
import { dealDocumentTitle } from "../issue";
import { emptyFormValues } from "../forms/values";
import { EQUIPMENT_FORM } from "../forms/equipment";
import { EQUIPMENT_HOUSE_SOURCE } from "../texts/equipment-house";

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
  price: 30_000_000, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハウス<b>", address: "架空県架空市2-2", lotNumber: "2番2", landArea: 120.5, floorArea: 95.2, structure: "木造2階建", layout: "4LDK", landRight: "ownership" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: { buildingTax: 1_000_000 }, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const settings = { ...resolveDealSettings(null), representativeTitle: "代表取締役", representativeName: "架空 太郎" };
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings, company, rateRows, today: "2026-10-28", logo: null, seal: "data:image/png;base64,c2VhbA==",
  staff: { sales: "架空 営業", ops: null },
});
const K = "equipment";
const doc = () => businessDocOf(K)!;
const blank = (kind: string, withGuide = "付けない") => ({ ...emptyFormValues(EQUIPMENT_FORM), kind, withGuide });
const count = (h: string) => (h.match(/class="circle"/g) ?? []).length;

describe("付帯設備表(第2段階 §4.8)", () => {
  it("「契約・媒介の書類」の告知書の次・土地だけの物件には出さない・前回の入力を引き継ぐ・種類はタブ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("disclosure") + 1);
    expect(doc().label).toBe("付帯設備表");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().form).toBe(EQUIPMENT_FORM);
    expect(doc().applies(ctx())).toBe(true);
    expect(doc().applies(ctx({ ...deal, propertyKind: "land" }))).toBe(false);
    expect(doc().applies(ctx({ ...deal, propertyKind: "custom_kind" }))).toBe(true);
    expect(dealDocumentTitle(K, "default")).toBe("付帯設備表");
  });

  it("初めの値: 種類は物件の元の種別から・説明のページは付ける", () => {
    expect(doc().defaults(ctx()).values).toMatchObject({ kind: "house", withGuide: "付ける" });
    expect(doc().defaults(ctx({ ...deal, propertyKind: "unit" })).values.kind).toBe("unit");
    expect(doc().options.safeParse(doc().defaults(ctx()).values).success).toBe(true);
  });

  it("全部空欄(手書き用): 題名・物件名・頭の説明文・4列の表・丸は付かない・署名の欄は空欄", () => {
    const h = doc().build(ctx(), blank("house")).html;
    expect(h).toContain("付帯設備表（土地建物用）");
    expect(h).toContain("試験ハウス&lt;b&gt;");
    expect(h).toContain("「設備の有無」欄に「有」とした付帯設備等は");
    expect(h).toContain("<th>主要設備の名称</th>");
    expect(h).toContain("<th>設備の有無</th>");
    expect(h).toContain("給湯器");
    expect(h).toContain("太陽光発電システム");
    expect(h).toContain("※注２の表示が「有」の設備は");
    expect(h).toContain("本物件の付帯設備が上記のとおりであることを売主は、買主に告知しました。");
    expect(count(h)).toBe(0);
    expect(h).not.toContain("架空 一郎");
    expect(h).not.toContain("ご記入にあたって");
  });

  it("選んだ設備の有無・内容の言葉だけを丸で囲む(同じ字がほかにあっても囲まない)・故障の書き込みはエスケープ", () => {
    const o = { ...blank("house"), h01: "有", h01D0: ["ガス"], h01S: "無", h01Fault: "<異音>", h17D0: ["有"], h28Place: "居間", h28Count: "2" };
    const h = doc().build(ctx(), o).html;
    expect(h).toContain('<span class="circle">ガス</span>');
    expect(h).toContain("&lt;異音&gt;");
    expect(h).toContain("居間");
    expect(h).toMatch(/計<span class="form-text">2<\/span>台|計2台/);
    // 給湯器の有・特定保守製品の無・鏡（有・無）の有・ガス = 4つ
    expect(count(h)).toBe(4);
  });

  it("区分所有建物用: 区分の設備だけ", () => {
    const h = doc().build(ctx(), blank("unit")).html;
    expect(h).toContain("付帯設備表（区分所有建物用）");
    expect(h).toContain("ＴＶ共視聴設備");
    expect(h).not.toContain("庭木・庭石");
  });

  it("説明のページを付ける: 表紙と「ご記入にあたって」を後ろに", () => {
    const h = doc().build(ctx(), blank("house", "付ける")).html;
    expect(h).toContain(EQUIPMENT_HOUSE_SOURCE.coverTitle);
    expect(h.indexOf("上記のとおり、売主より告知を受けました")).toBeLessThan(h.indexOf(EQUIPMENT_HOUSE_SOURCE.coverTitle));
  });

  it("Excel の行は選んだ種類の設備だけ", () => {
    const rows = doc().build(ctx(), { ...blank("house"), h01: "有" }).rows;
    expect(rows).toContainEqual({ label: "給湯関係 給湯器", value: "有" });
    expect(rows.map((r) => r.label)).not.toContain("ＴＶ共視聴設備");
  });

  it("括弧の入った言葉(食器棚（造付）)も丸で囲める・書式で2行の内容は2行で出す・小さな見出し(最終レビュー)", () => {
    const h = doc().build(ctx(), { ...blank("house"), h39D0: ["食器棚（造付）"] }).html;
    expect(h).toContain('<span class="circle">食器棚（造付）</span>');
    expect(h).toContain("キッチン設備");
    const u = doc().build(ctx(), { ...blank("unit"), u21D0: ["鏡"] }).html;
    expect(u).toMatch(/（洗面台・照明・シャワー・コンセント<br><span class="circle">鏡<\/span>・曇り止め）/);
  });
});
