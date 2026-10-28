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

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const party = (p: Partial<DealPartyView> & Pick<DealPartyView, "id" | "role" | "name">): DealPartyView => ({
  partyType: "individual", representative: null, address: null, phone: null, shareNum: null, shareDen: null, isSelf: false, sortOrder: 0, version: 1, ...p,
});
const deal: DealView = {
  id: "d", dealNo: "2026-0041", name: "試験", businessType: "brokerage", tradeSide: "seller", status: "contracted",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "building", hasOc: false,
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: null,
  price: 50_000_000, buildingTax: null, deposit: 2_000_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験ハイツ<b>", address: "架空県架空市2-2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: DEFAULT_TERMS, leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "",
  parties: [party({ id: "s", role: "seller", name: "架空 一郎<i>" }), party({ id: "b", role: "buyer", name: "架空 花子" })],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "架空県知事(1)第00000号", tel: "03-0000-0000", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const ctx = (d: DealView = deal, activeRights = 0): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-28"),
  settings: resolveDealSettings(null), company, rateRows, today: "2026-10-28", logo: null, seal: null,
  staff: { sales: "架空 営業", ops: null }, registry: { activeRights, caution: null },
});
const K = "prep_checklist";
const doc = () => businessDocOf(K)!;
const order = (h: string, words: string[]) => words.map((w) => h.indexOf(w));

describe("準備チェックリスト(第2段階 §4.4)", () => {
  it("書類確認書のまとまりの、書類確認書(決済時)の次・どの取引でも出せる", () => {
    const keys = BUSINESS_DOCS.map((d) => d.key);
    expect(keys.indexOf(K)).toBe(keys.indexOf("checklist_settlement") + 1);
    expect(doc().label).toBe("準備チェックリスト");
    expect(doc().group).toBe("checklist");
    expect(doc().applies(ctx())).toBe(true);
    expect(dealDocumentTitle(K, "default")).toBe("準備チェックリスト");
  });

  it("種類の初期値は物件の元の種別から(区分=マンション用・それ以外=土地建物用・決まらなければ選ぶ)", () => {
    expect(doc().defaults(ctx()).values.kind).toBe("land");
    expect(doc().defaults(ctx({ ...deal, propertyKind: "unit" })).values.kind).toBe("unit");
    expect(doc().defaults(ctx({ ...deal, propertyKind: "custom_kind" })).values.kind).toBeNull();
    expect(doc().defaults(ctx()).choices?.kind).toEqual([{ value: "land", label: "土地建物用" }, { value: "unit", label: "マンション用" }]);
    expect(doc().missing(ctx())).toEqual([]);
    expect(doc().missing(ctx({ ...deal, propertyKind: "custom_kind", contractAt: null, settlementAt: null }))).toEqual(["物件の種別", "契約日", "決済日"]);
    expect(doc().options.safeParse({ kind: null }).success).toBe(false);
    expect(doc().options.safeParse({ kind: "land", extra: 1 }).success).toBe(false);
  });

  it("並びは 契約前 → 契約日 → 決済前 → 決済日。列は 済・項目・メモ・期日・担当、期日はその時点の日付", () => {
    const h = doc().build(ctx(), { kind: "land" }).html;
    expect(h).toContain("準備チェックリスト(土地建物用)");
    const at = order(h, ["<h2>契約前</h2>", "<h2>契約日</h2>", "<h2>決済前</h2>", "<h2>決済日</h2>"]);
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(h).toContain("<th>済</th><th>項目</th><th>メモ</th><th>期日</th><th>担当</th>");
    expect(h).toContain("2026年5月1日");
    expect(h).toContain("2026年6月30日");
    expect(h).toContain("境界・越境の確認");
    expect(h).not.toContain("管理規約・重要事項調査報告書の取得");
    expect(h).toContain("試験ハイツ&lt;b&gt;");
    expect(h).toContain("架空 一郎&lt;i&gt;");
  });

  it("マンション用は区分だけの項目を入れ、土地のある物件だけの項目は入れない", () => {
    const h = doc().build(ctx(), { kind: "unit" }).html;
    expect(h).toContain("準備チェックリスト(マンション用)");
    expect(h).toContain("管理規約・重要事項調査報告書の取得");
    expect(h).not.toContain("境界・越境の確認");
  });

  it("使う書類で出し分ける(準備チェックリストだけ=出す・書類確認書だけ=出さない)", () => {
    const c = ctx();
    const items = c.settings.checklistItems.map((i) =>
      i.id === "c_registry" ? { ...i, use: "prep" as const } : i.id === "c_identity" ? { ...i, use: "checklist" as const } : i);
    const c2 = { ...c, settings: { ...c.settings, checklistItems: items } };
    const prep = doc().build(c2, { kind: "land" }).html;
    expect(prep).toContain("登記事項証明書・公図の取得");
    expect(prep).not.toContain("当事者の本人確認");
    const cl = businessDocOf("checklist_contract")!.build(c2, { pay: {} }).html;
    expect(cl).not.toContain("登記事項証明書・公図の取得");
    expect(cl).toContain("当事者の本人確認");
  });

  it("謄本に権利が残っていれば、抹消の自動の行も入る", () => {
    const h = doc().build(ctx(deal, 2), { kind: "land" }).html;
    expect(h).toContain("司法書士への抹消の依頼(抵当権など 2件)");
    expect(h).toContain("抵当権抹消書類(金融機関)");
  });

  it("日付が無くても落ちない(期日は空欄)・Excel の行", () => {
    const out = doc().build(ctx({ ...deal, contractAt: null, settlementAt: null }), { kind: "land" });
    expect(out.html).not.toContain("2026年5月1日");
    expect(out.rows).toContainEqual({ label: "契約前", heading: true });
    expect(out.rows).toContainEqual({ label: "境界・越境の確認", value: null });
  });
});
