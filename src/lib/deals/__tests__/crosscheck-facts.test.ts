import { describe, it, expect } from "vitest";
import { CROSSCHECK_DOC_FIELDS } from "../crosscheck";
import { CROSSCHECK_FACTS_KEY, buildCrosscheckFacts, latestIssuedDocs, readIssuedFacts } from "../crosscheck-facts";
import { DEAL_DOC_TYPES } from "../documents/issue";

const deal = {
  price: 30_000_000, settlementAt: "2026-11-30T15:30:00.000Z",
  propertySnapshot: { floorArea: 65.5, landArea: 120 },
} as never;
const row = (over: object) => ({
  id: "d1", docType: "funding_plan", variant: "purchase", version: 2, issuedAt: new Date("2026-10-01T00:00:00Z"),
  inputSnapshot: {}, calcSnapshot: {}, ...over,
});

describe("発行の写しに残す値", () => {
  it("表の書類の鍵は、すべて今ある書類", () => {
    const known = Object.keys(DEAL_DOC_TYPES);
    for (const keys of Object.values(CROSSCHECK_DOC_FIELDS)) for (const k of keys) expect(known).toContain(k);
  });
  it("その書類が使う値だけを残す", () => {
    expect(buildCrosscheckFacts("key_receipt", deal)).toEqual({});
    expect(buildCrosscheckFacts("funding_plan", deal)).toEqual({ price: 30_000_000 });
    expect(buildCrosscheckFacts("mediation", deal)).toEqual({ price: 30_000_000 });
  });
  it("決済日は日本時間の日付で残す", () => {
    expect(buildCrosscheckFacts("contract_guide", deal)).toEqual({ settlementDate: "2026-12-01" });
  });
  it("書類確認書(決済時)は発行に使った担保の件数も残す", () => {
    expect(buildCrosscheckFacts("checklist_settlement", deal, { activeRights: 2 })).toEqual({ settlementDate: "2026-12-01", activeRights: 2 });
    expect(buildCrosscheckFacts("checklist_contract", deal, { activeRights: 2 })).toEqual({});
  });
  it("名前・住所は入らない", () => {
    const withPii = { ...(deal as object), parties: [{ name: "架空太郎", address: "架空県" }] } as never;
    expect(JSON.stringify(buildCrosscheckFacts("settlement_statement", withPii))).not.toContain("架空");
  });
});

describe("発行の写しを読む", () => {
  it("残した値を読む", () => {
    const f = readIssuedFacts(row({ docType: "settlement_statement", variant: "default", calcSnapshot: { [CROSSCHECK_FACTS_KEY]: { price: 1, settlementDate: "2026-12-01" } } }));
    expect(f).toMatchObject({ documentId: "d1", version: 2, price: 1, settlementDate: "2026-12-01" });
    expect(f.title).toBe("精算書");
  });
  it("過去の資金計画表は計算の結果の価格を読む", () => {
    expect(readIssuedFacts(row({ calcSnapshot: { price: 5 } })).price).toBe(5);
  });
  it("過去の事業計画書は仕入価格を読む(販売価格・面積は読まない)", () => {
    const f = readIssuedFacts(row({ docType: "business_plan", variant: "internal", calcSnapshot: { kindBase: "unit", areaSqm: 60, purchase: { priceIncl: 7 }, sale: { priceIncl: 9 } } }));
    expect(f).toMatchObject({ price: 7 });
    expect(f).not.toHaveProperty("floorArea");
    expect(f).not.toHaveProperty("landArea");
  });
  it("過去の業務書類には値が無い(undefined=確認できない)", () => {
    const f = readIssuedFacts(row({ docType: "settlement_statement", variant: "default", calcSnapshot: { settlement: { remaining: 1 } } }));
    expect(f.price).toBeUndefined();
    expect(f.settlementDate).toBeUndefined();
  });
  it("賃貸人変更のお知らせは選んだ変更日を読む", () => {
    const f = readIssuedFacts(row({ docType: "landlord_change_notice", variant: "default", inputSnapshot: { options: { changeOn: "2026-12-01" } } }));
    expect(f.settlementDate).toBe("2026-12-01");
  });
  it("形の違う値は読まない", () => {
    const f = readIssuedFacts(row({ docType: "settlement_statement", variant: "default", calcSnapshot: { [CROSSCHECK_FACTS_KEY]: { price: "x", activeRights: {} } } }));
    expect(f.price).toBeUndefined();
    expect(f.activeRights).toBeUndefined();
  });
  it("種類・出し分けごとの最新版だけを残す", () => {
    const rows = [
      { docType: "funding_plan", variant: "purchase", v: 2 }, { docType: "funding_plan", variant: "purchase", v: 1 },
      { docType: "funding_plan", variant: "sale", v: 1 },
    ];
    expect(latestIssuedDocs(rows).map((r) => r.v + r.variant)).toEqual(["2purchase", "1sale"]);
  });
});
