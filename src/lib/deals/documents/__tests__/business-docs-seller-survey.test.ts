import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { SELLER_SURVEY_FORM } from "../forms/seller-survey";
import { emptyFormValues, formItems } from "../forms/values";
import { BUSINESS_DOCS, businessDocOf } from "../registry";
import { dealDocumentTitle } from "../issue";

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const S1 = party({ id: "p-s1", role: "seller", name: "架空 一郎<i>", address: "架空県架空市1-1", shareNum: 1, shareDen: 2 });
const S2 = party({ id: "p-s2", role: "seller", name: "架空 次郎", address: null, shareNum: 1, shareDen: 2, sortOrder: 1 });
const BUYER = party({ id: "p-b", role: "buyer", name: "架空 花子" });
const deal: DealView = {
  id: "d", dealNo: "2026-0031", name: "試験", businessType: "brokerage", tradeSide: "seller", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: "prop-1", propertyKind: "building", hasOc: false,
  contractAt: null, contractPlace: null, settlementAt: null, settlementPlace: null,
  price: 50_000_000, buildingTax: null, deposit: null, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [S1, S2, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const ctx = (d: DealView = deal, registry: BusinessDocContext["registry"] = { activeRights: 2, caution: "乙区 1番 抵当権が残っています。" }): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings: resolveDealSettings(null), company, rateRows, today: "2026-10-28", logo: null, seal: "data:image/png;base64,c2VhbA==",
  staff: { sales: "架空 営業", ops: null }, registry,
});
const K = "seller_survey";
const doc = () => businessDocOf(K)!;

describe("売主属性調査書(社内用)", () => {
  it("「契約・媒介の書類」の契約のご案内の次・売主がいる取引だけ・前回の入力を引き継ぐ・謄本を読む", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("contract_guide") + 1);
    expect(doc().label).toBe("売主属性調査書(社内用)");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().usesRegistry).toBe(true);
    expect(doc().form).toBe(SELLER_SURVEY_FORM);
    expect(doc().applies(ctx())).toBe(true);
    expect(doc().applies(ctx({ ...deal, parties: [BUYER] }))).toBe(false);
    expect(dealDocumentTitle(K, "default")).toBe("売主属性調査書(社内用)");
  });

  it("項目の表: 設計 §4.2 の5つの区切り・鍵が重ならない・前の会社の項目が無い", () => {
    const titles = SELLER_SURVEY_FORM.entries.filter((e) => e.kind === "section").map((e) => (e as { title: string }).title);
    expect(titles).toEqual(["1. 売主のこと", "2. 確認したこと", "3. 売却の経緯", "4. 物件のこと", "5. 注意事項"]);
    const keys = formItems(SELLER_SURVEY_FORM).flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]);
    expect(new Set(keys).size).toBe(keys.length);
    const labels = JSON.stringify(SELLER_SURVEY_FORM);
    for (const w of ["取引先マスタ", "リースバック", "インテリックス"]) expect(labels).not.toContain(w);
    for (const w of ["非居住者", "反社会的勢力", "成年後見", "取得の原因", "売却の理由", "第三者からの異議", "今の使い方", "差押え・仮登記", "抵当権など", "近隣との取り決め"]) expect(labels).toContain(w);
  });

  it("初期値: 個人・法人と共有者は取引の売主から。ほかは空欄", () => {
    const v = doc().defaults(ctx()).values;
    expect(v.sellerType).toBe("individual");
    expect(v.coOwners).toBe("yes");
    expect(v.mortgage).toBeNull();
    expect(doc().defaults(ctx({ ...deal, parties: [{ ...S1, partyType: "corporation" }] })).values).toMatchObject({ sellerType: "corporation", coOwners: "no" });
    expect(doc().defaults(ctx({ ...deal, parties: [S1, { ...S2, partyType: "corporation" }] })).values.sellerType).toBeNull();
    expect(doc().options.parse(doc().defaults(ctx()).values)).toBeTruthy();
  });

  it("空欄の確認: 売主の住所・営業担当", () => {
    expect(doc().missing(ctx())).toEqual(["売主の住所"]);
    expect(doc().missing({ ...ctx({ ...deal, parties: [S1] }), staff: { sales: null, ops: null } })).toEqual(["営業担当"]);
    expect(doc().blocking(ctx())).toEqual([]);
  });

  it("組み立て(全部空欄=手書き用): 社内用・自動で入る値・売主全員と持分・□ だけ", () => {
    const out = doc().build(ctx(), emptyFormValues(SELLER_SURVEY_FORM));
    expect(out.html).toContain("売主属性調査書(社内用)");
    expect(out.html).toContain("お客様にはお渡ししません");
    expect(out.html).toContain("2026-0031");
    expect(out.html).toContain("試験ハイツ&lt;b&gt;");
    expect(out.html).toContain("2026年10月28日");
    expect(out.html).toContain("架空 営業");
    expect(out.html).toContain("架空 一郎&lt;i&gt;");
    expect(out.html).toContain("架空 次郎");
    expect(out.html).toContain("1/2");
    expect(out.html).toContain("抹消の手続きが要る権利 2件");
    expect(out.html).toContain("乙区 1番 抵当権が残っています。");
    expect(out.html).toContain("□ 個人");
    expect(out.html).not.toContain("■");
    expect(out.html).not.toContain("源泉徴収");
    expect(out.html).not.toContain("c2VhbA==");
    expect(out.rows).toContainEqual({ label: "売主1", value: "架空 一郎<i> / 架空県架空市1-1 / 1/2" });
    expect(out.rows).toContainEqual({ label: "1. 売主のこと", heading: true });
  });

  it("組み立て(選んだもの): ■ で印字・非居住者なら源泉徴収の注意", () => {
    const out = doc().build(ctx(), { ...emptyFormValues(SELLER_SURVEY_FORM), sellerType: "individual", nonResident: "yes", remarksText: "<注意>" });
    expect(out.html).toContain("■ 個人");
    expect(out.html).toContain("源泉徴収");
    expect(out.html).toContain("&lt;注意&gt;");
    expect(out.rows).toContainEqual({ label: "非居住者", value: "該当する" });
  });

  it("謄本の権利が読めない・見られないときは「無い」と言い切らない", () => {
    expect(doc().build(ctx(deal, { activeRights: 0, caution: null }), emptyFormValues(SELLER_SURVEY_FORM)).html).toContain("謄本で確かめてください");
    expect(doc().build({ ...ctx(), registry: undefined }, emptyFormValues(SELLER_SURVEY_FORM)).html).toContain("謄本で確かめてください");
  });

  it("前の会社の名前・リースバックの語を使わない", () => {
    for (const f of ["business/seller-survey.ts", "forms/seller-survey.ts", "forms/render.ts", "forms/schema.ts", "forms/values.ts", "forms/types.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/lib/deals/documents", f), "utf8");
      for (const w of ["インテリックス", "リースバック", "取引先マスタ"]) expect(src, `${f} に ${w}`).not.toContain(w);
      // 「LB」は英字の続かない単語だけを見る(LBL などの英字の中の LB は当てない・2026-10-30)
      expect(src, `${f} に LB`).not.toMatch(/(?<![A-Za-z])LB(?![A-Za-z])/);
    }
  });
});
