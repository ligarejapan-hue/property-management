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
import { DISCLOSURE_FORM } from "../forms/disclosure";
import { DISCLOSURE_HOUSE_SOURCE } from "../texts/disclosure-house";

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
const K = "disclosure";
const doc = () => businessDocOf(K)!;
const blank = (kind: string, withGuide = "付けない") => ({ ...emptyFormValues(DISCLOSURE_FORM), kind, withGuide });
const squeeze = (s: string) => s.replace(/[\s\u3000]/g, "");

describe("物件状況確認書(告知書・第2段階 §4.7)", () => {
  it("「契約・媒介の書類」の説明書の次・どの取引でも出せる・前回の入力を引き継ぐ・種類はタブ", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("sale_guide") + 1);
    expect(doc().label).toBe("物件状況確認書(告知書)");
    expect(doc().group).toBe("contract");
    expect(doc().remember).toBe(true);
    expect(doc().form).toBe(DISCLOSURE_FORM);
    expect(doc().applies(ctx({ ...deal, businessType: "resale", tradeSide: null }))).toBe(true);
    expect(dealDocumentTitle(K, "default")).toBe("物件状況確認書(告知書)");
  });

  it("初めの値: 種類は物件の元の種別から・説明のページは付ける", () => {
    expect(doc().defaults(ctx()).values).toMatchObject({ kind: "house", withGuide: "付ける" });
    expect(doc().defaults(ctx({ ...deal, propertyKind: "unit" })).values.kind).toBe("unit");
    expect(doc().defaults(ctx({ ...deal, propertyKind: "land" })).values.kind).toBe("house");
    expect(doc().options.safeParse(doc().defaults(ctx()).values).success).toBe(true);
  });

  it("空欄の確認: 物件名(物件名も所在地も無いとき)", () => {
    expect(doc().missing(ctx())).toEqual([]);
    expect(doc().missing(ctx({ ...deal, propertySnapshot: EMPTY_SNAPSHOT }))).toEqual(["物件名"]);
  });

  it("全部空欄(手書き用): 題名・物件名・書式の文・□ だけ・署名の欄は空欄・説明のページなし", () => {
    const h = doc().build(ctx(), blank("house")).html;
    expect(h).toContain("物件状況確認書（告知書／土地建物・土地用）");
    expect(h).toContain("試験ハウス&lt;b&gt;");
    expect(h).toContain("売主は、売主が現在知っている売買物件の状況について、以下のとおり買主に説明いたします。");
    expect(h).toContain("□ 現在まで雨漏りを発見していない。");
    expect(h).toContain("㉕その他売主から買主に引き継ぐ事項");
    expect(h).not.toContain("■");
    expect(h).toContain("本物件の状況が上記のとおりであることを売主は、買主に告知しました。");
    expect(h).toContain("上記のとおり、売主より告知を受けました。");
    expect(h).not.toContain("架空 一郎");
    expect(h).not.toContain("ご記入にあたって");
    expect(h).not.toContain("表２");
    expect(h).not.toContain("c2VhbA==");
  });

  it("選んだものは ■・書き込みはエスケープ・Excel の行", () => {
    const o = { ...blank("house"), h01b: ["過去に雨漏りがあった。"], h01bPlace: "<北側>", h01c: "済", h01cY: "2020", h01cM: "5" };
    const out = doc().build(ctx(), o);
    expect(out.html).toContain("■ 過去に雨漏りがあった。");
    expect(out.html).toContain("&lt;北側&gt;");
    expect(out.html).toContain("■ 済");
    expect(out.rows).toContainEqual({ label: "①雨漏り 修理工事：", value: "済" });
  });

  it("区分所有建物用: 表１・表２・区分の項目だけ", () => {
    const h = doc().build(ctx(), blank("unit")).html;
    expect(h).toContain("物件状況確認書（告知書／区分所有建物用）");
    expect(h).toContain("表２ 管理費・修繕積立金の変更予定");
    expect(h).toContain("④管理組合集会における討議事項");
    expect(h).not.toContain("⑫境界について");
  });

  it("説明のページを付ける: 表紙と「ご記入にあたって」(人の死の告知のガイドラインを含む)を後ろに", () => {
    const h = doc().build(ctx(), blank("house", "付ける")).html;
    expect(h).toContain(DISCLOSURE_HOUSE_SOURCE.coverTitle);
    expect(h).toContain("物件状況確認書（告知書／土地建物・土地用）ご記入にあたって");
    expect(squeeze(h)).toContain(squeeze("宅地建物取引業者による人の死の告知に関するガイドライン"));
    expect(h.indexOf("上記のとおり、売主より告知を受けました。")).toBeLessThan(h.indexOf(DISCLOSURE_HOUSE_SOURCE.coverTitle));
  });

  it("書式の頭の文と署名の文は、全宅連の書式のセルの文字と一字も違わない", async () => {
    const { DISCLOSURE_HEAD_TEXTS } = await import("../business/disclosure");
    for (const [kind, texts] of Object.entries(DISCLOSURE_HEAD_TEXTS)) {
      const src = kind === "house" ? DISCLOSURE_HOUSE_SOURCE : (await import("../texts/disclosure-unit")).DISCLOSURE_UNIT_SOURCE;
      for (const t of texts) expect(squeeze(src.formCells.join("")), t).toContain(squeeze(t));
    }
  });

  it("書式に無い字を足さない・欠かさない(最終レビュー)", () => {
    const h = doc().build(ctx(), blank("house")).html;
    // 名前の無い書き込み欄・「／」「）」で終わる名前に「:」を付けない
    expect(h).not.toContain('>:<span class="form-blank');
    expect(h).not.toContain("／:");
    expect(h).not.toContain("その他:");
    // ⑭ 方角:＿＿側／所有者：□売主
    expect(h).toMatch(/方角:<span class="form-blank short"><\/span>側<\/span>\s*／所有者：<span class="form-choice">□ 売主/);
    // ⑥ □無 □有 時期：＿年＿月頃(時期だけの欄は作らない)
    expect(h).toMatch(/□ 有<\/span><span class="form-field-inline">時期：<span class="form-blank short"><\/span>年/);
    expect(h).toContain("調査年月日：");
    const u = doc().build(ctx(), blank("unit")).html;
    expect(u).toContain("作成年月日：");
    expect(u).toMatch(/□ その他<\/span><span class="form-field-inline">（資料名：<span class="form-blank short"><\/span>）/);
    expect(u).not.toContain("その他（資料名：<span");
  });

  it("書き込む行の多い欄は、行の数だけ下線を出す(手で書けるように・最終レビュー)", () => {
    const h = doc().build(ctx(), blank("house")).html;
    expect(h).toContain('<span class="form-blank"></span><br><span class="form-blank"></span><br><span class="form-blank"></span>');
  });

  it("「すべて空欄に戻す」でも説明のページの設定は残す・設定が空なら付ける(最終レビュー)", async () => {
    const { clearFormValues } = await import("../forms/values");
    expect(clearFormValues(DISCLOSURE_FORM, { kind: "unit", withGuide: "付けない", u01c: "済" })).toMatchObject({ kind: "unit", withGuide: "付けない", u01c: null });
    const h = doc().build(ctx(), { ...blank("house"), withGuide: null }).html;
    expect(h).toContain(DISCLOSURE_HOUSE_SOURCE.coverTitle);
  });
});
