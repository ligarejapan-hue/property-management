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
import { emptyFormValues } from "../forms/values";
import { MEDIATION_FORM } from "../forms/mediation";
import { MEDIATION_EXCLUSIVE } from "../texts/mediation-exclusive";
import { MEDIATION_GENERAL } from "../texts/mediation-general";
import { MEDIATION_DEDICATED } from "../texts/mediation-dedicated";
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
const K = "mediation";
const doc = () => businessDocOf(K)!;
const blank = (kind: string) => ({ ...emptyFormValues(MEDIATION_FORM), kind });
/** タグを外して、HTML の文字参照を戻す。 */
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");

describe("媒介契約書(第2段階 §4.5・型はタブで選ぶ)", () => {
  it("「契約・媒介の書類」の売主属性調査書の次に1つ・仲介の取引だけ・前回の入力を引き継ぐ・型はタブ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("seller_survey") + 1);
    expect(doc().label).toBe("媒介契約書");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().form).toBe(MEDIATION_FORM);
    expect(MEDIATION_FORM.tabs).toEqual({ key: "kind", label: "契約の型", choices: [{ value: "general", label: "一般" }, { value: "exclusive", label: "専任" }, { value: "dedicated", label: "専属専任" }] });
    expect(doc().applies(ctx())).toBe(true);
    expect(doc().applies(ctx({ ...deal, businessType: "resale", tradeSide: null }))).toBe(false);
    expect(dealDocumentTitle(K, "default")).toBe("媒介契約書");
  });

  it("初めの値: 型は専任・依頼の内容は取引の側から・報告と登録と有効期間は法の範囲でいちばん長いもの・報酬は計算の仲介手数料", () => {
    const v = doc().defaults(ctx()).values;
    expect(v.kind).toBe("exclusive");
    expect(v.requestKind).toBe("sale");
    expect(v.reportMethod).toBe("document");
    expect(v.reportFrequencyExclusive).toBe("２週間に１");
    expect(v.reportFrequencyDedicated).toBe("１週間に１");
    expect(v.registerDaysExclusive).toBe("7");
    expect(v.registerDaysDedicated).toBe("5");
    expect(v.months).toBe("3");
    expect(v.feeExcl).toMatch(/^[\d,]+$/);
    expect(v.feeTax).toMatch(/^[\d,]+$/);
    expect(doc().defaults(ctx({ ...deal, tradeSide: "buyer" })).values.requestKind).toBe("purchase");
    expect(doc().options.safeParse(v).success).toBe(true);
  });

  it("法の範囲を超える頻度・日数・月数は選べない(サーバーも断る)", () => {
    for (const bad of [{ reportFrequencyDedicated: "２週間に１" }, { registerDaysDedicated: "7" }, { registerDaysExclusive: "8" }, { months: "4" }, { kind: "other" }]) {
      expect(doc().options.safeParse({ ...blank("exclusive"), ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("タブで出す欄が変わる(一般=重ねて依頼する業者・登録の有無/専任・専属専任=報告と登録)", () => {
    const keysOf = (kind: string) => MEDIATION_FORM.entries.filter((e) => e.kind === "item" && (!e.only || e.only.includes(kind))).map((e) => (e.kind === "item" ? e.key : ""));
    expect(keysOf("general")).toContain("otherAgentsItem");
    expect(keysOf("general")).not.toContain("reportMethod");
    expect(keysOf("exclusive")).toContain("reportFrequencyExclusive");
    expect(keysOf("exclusive")).not.toContain("reportFrequencyDedicated");
    expect(keysOf("dedicated")).toContain("registerDaysDedicated");
    expect(keysOf("dedicated")).not.toContain("otherAgentsItem");
  });

  it("空欄の確認: 依頼者・物件の所在地・売買価格", () => {
    expect(doc().missing(ctx())).toEqual([]);
    expect(doc().missing(ctx({ ...deal, parties: [BUYER], price: null, propertySnapshot: EMPTY_SNAPSHOT }))).toEqual(["依頼者", "物件の所在地", "売買価格"]);
    expect(doc().missing(ctx({ ...deal, parties: [SELLER] }), { requestKind: "purchase" })).toEqual(["依頼者"]);
  });

  it("3つの型とも、全部空欄で出しても契約書の頁と約款の文面は写した文面と一字も違わない(下線を除く)", () => {
    for (const [kind, src] of [["general", MEDIATION_GENERAL], ["exclusive", MEDIATION_EXCLUSIVE], ["dedicated", MEDIATION_DEDICATED]] as const) {
      const h = doc().build(ctx(), blank(kind)).html;
      const t = text(h);
      expect(t).toContain(src.title);
      for (const p of src.contract) expect(t, `${kind}: ${p}`).toContain(p.replace(/＿/g, ""));
      for (const p of src.clauses) expect(t, `${kind}: ${p}`).toContain(p);
      expect(t).toContain(src.clausesTitle);
      expect(h).not.toContain("c2VhbA==");
    }
  });

  it("入れた値は目印のすぐ後ろに差し込む・選んだものは丸で囲む(専任)", () => {
    const o = {
      ...blank("exclusive"), requestKind: "sale", reportMethod: "email", reportFrequencyExclusive: "１週間に１", registryName: "架空流通機構",
      registerDaysExclusive: "5", inspection: "no", inspectionReason: "<築古>", months: "3", expiry: "2027年1月31日", feeExcl: "1,056,000", feeTax: "105,600",
      feeTiming: "売買契約の締結時に半額、決済時に残額", specialTerms: "特になし",
    };
    const h = doc().build(ctx(), o).html;
    const t = text(h);
    expect(t).toContain("（注１）電子メールにより、（注２）１週間に１回以上");
    expect(t).toContain("（注３）架空流通機構に");
    expect(t).toContain("（注４）5日以内");
    expect(t).toContain("＊　<築古>");
    expect(h).toContain("&lt;築古&gt;");
    expect(t).toContain("この媒介契約締結後3ヶ月（2027年1月31日まで）");
    expect(t).toContain("（消費税及び地方消費税抜き報酬額）1,056,000円と（消費税額及び地方消費税額の合計額）105,600円");
    expect(t).toContain("売買契約の締結時に半額、決済時に残額とします。");
    expect(h).toMatch(/<span class="circle">売却<\/span>/);
    expect(h).toMatch(/<span class="circle">無<\/span>/);
  });

  it("専属専任は専属専任の欄の値を使う(専任の欄の値は使わない)", () => {
    const o = { ...blank("dedicated"), reportFrequencyExclusive: "２週間に１", reportFrequencyDedicated: "１週間に１", registerDaysExclusive: "7", registerDaysDedicated: "3" };
    const t = text(doc().build(ctx(), o).html);
    expect(t).toContain("専属専任媒介契約書");
    expect(t).toContain("（注２）１週間に１回以上");
    expect(t).toContain("（注４）3日以内");
  });

  it("依頼者・宅建業者の欄・別表(自動で入る値・エスケープ)", () => {
    const h = doc().build(ctx(), blank("exclusive")).html;
    expect(h).toContain("架空 一郎&lt;i&gt;");
    expect(h).toContain("架空県架空市1-1");
    expect(h).toContain("架空不動産株式会社");
    expect(h).toContain("代表取締役 架空 太郎");
    expect(h).toContain("架空県架空市3-3");
    expect(h).toContain("架空県知事(1)第00000号");
    expect(h).toContain("架空県架空市2-2 2番2");
    expect(h).toContain("120.5");
    expect(h).toContain("95.2");
    expect(h).toContain("30,000,000円");
    expect(h).toContain("29,000,000円");
    expect(h).toContain("1,000,000円");
    // 購入の依頼なら依頼者は買主
    expect(doc().build(ctx(), { ...blank("exclusive"), requestKind: "purchase" }).html).toContain("架空 花子");
  });

  it("一般: 依頼する乙以外の業者を行ごとに・指定流通機構への登録の有無", () => {
    const o = { ...blank("general"), otherAgents: "架空住宅 / 架空県架空市5-5\n架空商事 / 架空県架空市6-6", listing: "yes", listingName: "架空流通機構" };
    const h = doc().build(ctx(), o).html;
    expect(h).toContain("一般媒介契約書");
    expect(h).toContain("架空住宅");
    expect(h).toContain("架空県架空市6-6");
    expect(text(h)).toContain("架空流通機構");
  });
});
