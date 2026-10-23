import { describe, it, expect } from "vitest";
import { settlementResult } from "../settlement";
import { computeDealCalc } from "../deal-calc";
import { DEFAULT_COSTS, DEFAULT_TERMS, EMPTY_BROKER, EMPTY_SNAPSHOT } from "../../schemas";
import { DEFAULT_PROPERTY_KINDS } from "../../constants";
import { INITIAL_RATE_TABLES, type RateTableRow } from "../../rate-tables";
import type { DealView } from "../../view";

const lease = {
  room: "101", tenant: "試験 次郎", contractType: "ordinary" as const, period: null, rent: 80_000, commonFee: 5_000,
  parking: 0, other: 0, deposit: 160_000, arrears: false, arrearsAmount: 0, manager: null,
};
const base = {
  price: 30_000_000, deposit: 1_500_000, kindBase: "unit" as const, hasOc: false, settlementDate: "2026-07-01",
  terms: { ...DEFAULT_TERMS, fixedAssetTax: 100_000, cityPlanningTax: 20_000, managementFee: 20_000, repairReserve: 10_000 },
  leases: [], overrides: {},
};

describe("決済の計算", () => {
  it("決済日が無ければ計算しない", () => {
    const r = settlementResult({ ...base, settlementDate: null });
    expect(r).toMatchObject({ ready: false, missing: ["決済日時"], rows: [] });
  });
  it("固都税(年税額の合計)と管理費等(区分だけ)を買主から売主へ", () => {
    const r = settlementResult(base);
    expect(r.rows.map((x) => x.key)).toEqual(["propertyTax", "management"]);
    expect(r.rows[0]).toMatchObject({ label: "固定資産税・都市計画税", buyerToSeller: 60_493, sellerToBuyer: 0, formula: "120,000円×184日÷365日", period: "2026-07-01〜2026-12-31" });
    expect(r.rows[1]).toMatchObject({ buyerToSeller: 30_000 });
    expect(r.net).toEqual({ direction: "buyerToSeller", amount: 90_493 });
    expect(r.netLine).toBe("買主から売主へ 90,493円");
    expect(r.remaining).toBe(28_500_000);
    expect(r.paymentAtSettlement).toBe(28_590_493);
  });
  it("土地・戸建では管理費の行を出さない", () => {
    expect(settlementResult({ ...base, kindBase: "land" }).rows.map((x) => x.key)).toEqual(["propertyTax"]);
  });
  it("OC: 賃料は売主から買主へ・敷金は相殺ならお支払額から引く", () => {
    const r = settlementResult({ ...base, kindBase: "building", hasOc: true, leases: [lease, { ...lease, room: "102", deposit: 80_000 }] });
    const rent = r.rows.find((x) => x.key === "rent")!;
    expect(rent.sellerToBuyer).toBe(Math.floor((170_000 * 31) / 31));
    expect(r.depositRow).toMatchObject({ sellerToBuyer: 240_000, note: "残代金と相殺" });
    expect(r.depositOffset).toBe(240_000);
    expect(r.paymentAtSettlement).toBe(28_500_000 + (r.totalBuyerToSeller - r.totalSellerToBuyer) - 240_000);
  });
  it("敷金を別途にすればお支払額から引かない", () => {
    const r = settlementResult({ ...base, hasOc: true, leases: [lease], terms: { ...base.terms, depositMode: "separate" } });
    expect(r.depositOffset).toBe(0);
    expect(r.depositRow?.note).toBe("別途授受");
  });
  it("手で直した値を使い、計算の値も持っておく", () => {
    const r = settlementResult({ ...base, overrides: { "settlement.propertyTax": 60_000 } });
    expect(r.rows[0]).toMatchObject({ buyerToSeller: 60_000, computed: 60_493, overridden: true });
  });
  it("その他の自由行を足す・4/1 起算の注意文を出す", () => {
    const r = settlementResult({ ...base, settlementDate: "2027-02-15", terms: { ...base.terms, taxStart: "04-01", others: [{ label: "測量費の負担分", sellerToBuyer: 0, buyerToSeller: 50_000 }] } });
    expect(r.rows.at(-1)).toMatchObject({ label: "測量費の負担分", buyerToSeller: 50_000 });
    expect(r.warnings[0]).toContain("起算日が4月1日");
  });
});

const rateRows: RateTableRow[] = INITIAL_RATE_TABLES.map((t) => ({
  kind: t.kind, validFrom: new Date(`${t.validFrom}T00:00:00Z`), validTo: t.validTo ? new Date(`${t.validTo}T00:00:00Z`) : null, content: t.content,
}));
const deal: DealView = {
  id: "d", dealNo: "2026-0001", name: "試験", businessType: "brokerage", tradeSide: "both", status: "considering",
  assigneeId: null, licensedAgentId: null, salesStaffId: null, opsStaffId: null, propertyId: null, propertyKind: "unit", hasOc: false,
  contractAt: "2026-05-01T01:00:00.000Z", contractPlace: null, settlementAt: "2026-07-01T01:00:00.000Z", settlementPlace: null,
  price: 30_000_000, buildingTax: null, deposit: 1_500_000, taxRateBp: 1000,
  propertySnapshot: EMPTY_SNAPSHOT, counterpartyBroker: EMPTY_BROKER,
  assessments: { rows: [{ building: 10_000_000, land: 20_000_000, shareNum: 1, shareDen: 1 }], landRatioBp: 10000 },
  costs: DEFAULT_COSTS, settlementTerms: base.terms, leases: [], overrides: {},
  version: 1, createdAt: "", updatedAt: "", parties: [],
};

describe("取引1件の計算結果", () => {
  it("手数料・建物価格と消費税・契約書の印紙・精算をまとめる(基準日=契約日)", () => {
    const c = computeDealCalc(deal, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.baseDate).toBe("2026-05-01");
    expect(c.brokerage).toMatchObject({ computedExcl: 960_000, excl: 960_000, incl: 1_056_000, overridden: false });
    expect(c.building).toMatchObject({ computedPrice: 10_000_000, price: 10_000_000, computedTax: 909_090, tax: 909_090 });
    expect(c.contractStamp).toBe(10_000);
    expect(c.settlement.netLine).toBe("買主から売主へ 90,493円");
  });
  it("上書き: 手数料・建物価格(→消費税は建物価格から計算し直す)", () => {
    const c = computeDealCalc({ ...deal, overrides: { brokerageFee: 900_000, buildingPrice: 11_000_000 } }, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.brokerage).toMatchObject({ excl: 900_000, incl: 990_000, overridden: true, computedExcl: 960_000 });
    expect(c.building).toMatchObject({ price: 11_000_000, priceOverridden: true, tax: 1_000_000 });
  });
  it("価格が無ければ手数料などは null・足りないものを並べる", () => {
    const c = computeDealCalc({ ...deal, price: null, contractAt: null, settlementAt: null }, rateRows, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.baseDate).toBe("2026-10-24");
    expect(c.brokerage).toBeNull();
    expect(c.missing).toEqual(expect.arrayContaining(["売買価格", "決済日時"]));
  });
});

describe("@codex: 元の金額が無くても、手で直した値は精算に入れる", () => {
  it("固都税が空でも上書きがあれば行を出す", () => {
    const r = settlementResult({ ...base, terms: { ...DEFAULT_TERMS }, overrides: { "settlement.propertyTax": 60_000 } });
    expect(r.rows.find((x) => x.key === "propertyTax")).toMatchObject({ buyerToSeller: 60_000, overridden: true, formula: null });
    expect(r.net.amount).toBe(60_000);
  });
  it("管理費(区分)・賃料(OC)も同じ・当てはまらない種別では出さない", () => {
    const r = settlementResult({ ...base, kindBase: "unit", hasOc: true, terms: { ...DEFAULT_TERMS }, overrides: { "settlement.management": 10_000, "settlement.rent": 5_000 } });
    expect(r.rows.map((x) => x.key)).toEqual(["management", "rent"]);
    const land = settlementResult({ ...base, kindBase: "land", hasOc: false, terms: { ...DEFAULT_TERMS }, overrides: { "settlement.management": 10_000, "settlement.rent": 5_000 } });
    expect(land.rows).toEqual([]);
  });
});

describe("@codex 3巡目: 手数料の表が無くても、手で直した手数料は使う", () => {
  it("表が当たらない日付でも上書きがあれば excl/incl を出す(計算の値は null)", () => {
    const noTiers = rateRows.filter((r) => r.kind !== "brokerage_tiers");
    const c = computeDealCalc({ ...deal, overrides: { brokerageFee: 900_000 } }, noTiers, DEFAULT_PROPERTY_KINDS, "2026-10-24");
    expect(c.brokerage).toMatchObject({ computedExcl: null, excl: 900_000, incl: 990_000, overridden: true });
    expect(computeDealCalc(deal, noTiers, DEFAULT_PROPERTY_KINDS, "2026-10-24").brokerage).toBeNull();
  });
});
