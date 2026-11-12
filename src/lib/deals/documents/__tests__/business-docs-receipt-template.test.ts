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
import { businessDocOf } from "../registry";
import { DocOptionError } from "../business/receipts";

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
  // 日本時間 2026-05-01 00:00
  contractAt: "2026-04-30T15:00:00.000Z", contractPlace: null, settlementAt: "2026-06-30T01:00:00.000Z", settlementPlace: "架空銀行 架空支店",
  price: 30_000_000, buildingTax: null, deposit: 4_280_000, taxRateBp: 1000,
  propertySnapshot: { ...EMPTY_SNAPSHOT, buildingName: "試験マンション<b>", roomNo: "201", address: "架空県架空市2-2", lotNumber: "2番2" },
  counterpartyBroker: EMPTY_BROKER, assessments: { rows: [], landRatioBp: 10000 }, costs: DEFAULT_COSTS,
  settlementTerms: { ...DEFAULT_TERMS, taxInputMode: "total", fixedAssetTax: 100_000, cityPlanningTax: 20_000, managementFee: 15_000, repairReserve: 5_000 },
  leases: [], overrides: {}, version: 1, createdAt: "", updatedAt: "", parties: [SELLER, BUYER],
  fundingPlan: DEFAULT_FUNDING_INPUTS, businessPlan: DEFAULT_BUSINESS_INPUTS,
};
const company: CompanyProfile = { nameJa: "架空不動産株式会社", license: "", tel: "", fax: "", email: "", hp: "", address: "架空県架空市3-3" };
const ctx = (d: DealView = deal): BusinessDocContext => ({
  deal: d, calc: computeDealCalc(d, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-25"), settings: resolveDealSettings(null),
  company, rateRows, today: "2026-10-25", logo: null, seal: "data:image/png;base64,c2VhbA==",
});
const doc = (key: string) => businessDocOf(key)!;
const opts = (issuer: string, exempt: "yes" | "no" | null = "no", receivedOn: string | null = "2026-05-01") => ({ issuer, exempt, receivedOn });
const LAND = { ...deal, propertyKind: "land", propertySnapshot: { ...EMPTY_SNAPSHOT, address: "架空県架空市5-5", lotNumber: "5番5" } };
const HOUSE = { ...LAND, propertyKind: "house" };

const notesOf = (kind: string, d: DealView) => (doc(kind).defaults(ctx(d)).choices?.partyNotes ?? []).map((n) => n.label);
const rowOf = (rows: { label: string; value?: unknown }[], label: string) => rows.find((r) => r.label === label)?.value;

describe("売主の当事者が発行する手付金・残金の領収書(2026-11-05 発注者)", () => {
  const cases = [
    ["deposit_receipt", "手付金", "4,280,000"],
    ["balance_receipt", "残代金", "25,720,000"],
  ] as const;
  for (const [kind, purpose, amount] of cases) {
    it(`${purpose}・区分: 但し書きは和暦の契約日・物件はマンション名と部屋番号`, () => {
      const { html, rows } = doc(kind).build(ctx(), opts(SELLER.id));
      expect(html).toContain("領 収 書");
      expect(html).toContain(`金 ${amount} 円也`);
      expect(html).toContain(`但し　令和8年5月1日付下記記載の不動産売買契約に基づく売買代金（${purpose}）として`);
      expect(html).toContain("上記の金額を正に領収いたしました。");
      expect(html).toContain(">記<");
      expect(html).toContain("物件</span>試験マンション&lt;b&gt;　201");
      expect(html).not.toContain("所在地</span>");
      expect(html).toContain('<div class="rc-top">令和8年5月1日</div>');
      expect(html).not.toContain("2026年");
      expect(html).toContain("架空 花子");
      expect(html).toContain("架空県架空市1-1");
      expect(html).toContain("署名・押印");
      // 二重線の飾り罫・細線の枠・余白なし
      expect(html).toContain(".rc-outer { position: absolute; inset: 12mm; border: 1mm double #000; }");
      expect(html).toContain(".rc-inner { position: absolute; inset: 15mm; border: 0.3mm solid #000; }");
      expect(html).toContain('<div class="rc-outer"></div><div class="rc-inner"></div>');
      expect(html).toContain("@page { size: A4 portrait; margin: 0; }");
      expect(rowOf(rows, "但し書き")).toBe(`但し　令和8年5月1日付下記記載の不動産売買契約に基づく売買代金（${purpose}）として`);
      expect(rowOf(rows, "物件")).toBe("試験マンション<b>　201");
      expect(rowOf(rows, "契約日")).toBe("令和8年5月1日");
      expect(notesOf(kind, deal)).toEqual([]);
    });
    for (const d of [LAND, HOUSE]) {
      it(`${purpose}・${d.propertyKind}: 物件は所在地(地番)`, () => {
        const { html, rows } = doc(kind).build(ctx(d), opts(SELLER.id));
        expect(html).toContain(`売買代金（${purpose}）として`);
        expect(html).toContain("所在地</span>架空県架空市5-5 5番5");
        expect(html).not.toContain("物件</span>");
        expect(rowOf(rows, "所在地")).toBe("架空県架空市5-5 5番5");
      });
    }
  }
  it("算用数字だけ(大字は使わない)", () => {
    const { html } = doc("deposit_receipt").build(ctx(), opts(SELLER.id));
    expect(html).not.toMatch(/[壱弐参萬阡拾]/);
  });
  it("契約日が無くても発行でき、日付は空欄・知らせが出る", () => {
    const d = { ...deal, contractAt: null };
    const { html, rows } = doc("deposit_receipt").build(ctx(d), opts(SELLER.id));
    expect(html).toContain("但し　　　年　　月　　日付下記記載の不動産売買契約");
    expect(rowOf(rows, "契約日")).toBeNull();
    expect(notesOf("deposit_receipt", d)).toEqual(["契約日が未入力のため、日付は空欄で出ます"]);
    expect(doc("deposit_receipt").blocking(ctx(d))).toEqual([]);
  });
  it("受領日は和暦(但し書きの契約日とそろえる・2026-11-05 発注者)", () => {
    for (const kind of ["deposit_receipt", "balance_receipt"]) {
      const { html, rows } = doc(kind).build(ctx(), opts(SELLER.id, "no", "2026-11-20"));
      expect(html).toContain('<div class="rc-top">令和8年11月20日</div>');
      expect(rowOf(rows, "受領日")).toBe("令和8年11月20日");
    }
  });
  it("受領日が無ければ空欄", () => {
    expect(doc("deposit_receipt").build(ctx(), opts(SELLER.id, "no", null)).html).toContain("　　年　　月　　日");
  });
  it("物件の値が欠けても空欄で発行でき、何が空欄かを知らせる(区分)", () => {
    const d = { ...deal, propertySnapshot: { ...EMPTY_SNAPSHOT } };
    const { html, rows } = doc("balance_receipt").build(ctx(d), opts(SELLER.id));
    expect(html).toContain("物件</span>　　　　　　　　　　");
    expect(rowOf(rows, "物件")).toBeNull();
    expect(notesOf("balance_receipt", d)).toEqual(["マンション名が未入力のため、空欄で出ます", "部屋番号が未入力のため、空欄で出ます"]);
  });
  it("物件の値が欠けても空欄で発行でき、何が空欄かを知らせる(土地・地番だけ欠け)", () => {
    const d = { ...LAND, propertySnapshot: { ...EMPTY_SNAPSHOT, address: "架空県架空市5-5" } };
    const { html, rows } = doc("deposit_receipt").build(ctx(d), opts(SELLER.id));
    expect(html).toContain("所在地</span>架空県架空市5-5 　　　　　");
    expect(rowOf(rows, "所在地")).toBe("架空県架空市5-5");
    expect(notesOf("deposit_receipt", d)).toEqual(["地番が未入力のため、空欄で出ます"]);
    expect(notesOf("deposit_receipt", { ...LAND, propertySnapshot: { ...EMPTY_SNAPSHOT } })).toEqual(["所在地が未入力のため、空欄で出ます", "地番が未入力のため、空欄で出ます"]);
  });
  it("物件の種類が未選択なら所在地で出す", () => {
    expect(doc("deposit_receipt").build(ctx({ ...deal, propertyKind: null }), opts(SELLER.id)).html).toContain("所在地</span>架空県架空市2-2 2番2");
  });
  it("印紙: 非課税なら「非課税（営業に関しない受取書）」・課税なら金額", () => {
    const ex = doc("deposit_receipt").build(ctx(), opts(SELLER.id, "yes"));
    expect(ex.html).toContain("非課税（営業に関しない受取書）");
    expect(rowOf(ex.rows, "収入印紙")).toBe("非課税（営業に関しない受取書）");
    expect(doc("deposit_receipt").build(ctx(), opts(SELLER.id, "no")).html).toContain("収入印紙<br>1,000円");
  });
  it("精算金領収書には知らせを出さない", () => {
    expect(notesOf("settlement_receipt", { ...deal, contractAt: null })).toEqual([]);
  });
});

describe("変えないもの(精算金領収書)", () => {
  // 控えは直す前の出力(2026-11-05)。
  it("精算金領収書(当事者が発行)", async () => {
    const out = doc("settlement_receipt").build(ctx(), opts(SELLER.id));
    await expect(out.html).toMatchFileSnapshot("./__snapshots__/receipt-settlement.html");
    await expect(JSON.stringify(out.rows, null, 1)).toMatchFileSnapshot("./__snapshots__/receipt-settlement.rows.json");
  });
  it("自社が発行する精算金領収書", async () => {
    const out = doc("settlement_receipt").build(ctx({ ...deal, parties: [SELF_SELLER, BUYER] }), opts("self", null));
    await expect(out.html).toMatchFileSnapshot("./__snapshots__/receipt-self-settlement_receipt.html");
    await expect(JSON.stringify(out.rows, null, 1)).toMatchFileSnapshot("./__snapshots__/receipt-self-settlement_receipt.rows.json");
  });
});

describe("手付金・残金の領収書は自社では出さない(2026-11-06 発注者)", () => {
  for (const kind of ["deposit_receipt", "balance_receipt"]) {
    it(`${kind}: 自社を渡すと組み立てない`, () => {
      expect(() => doc(kind).build(ctx({ ...deal, parties: [SELF_SELLER, BUYER] }), opts("self", null))).toThrow(DocOptionError);
      expect(() => doc(kind).build(ctx(), opts("self", null))).toThrow(DocOptionError);
    });
  }
});
