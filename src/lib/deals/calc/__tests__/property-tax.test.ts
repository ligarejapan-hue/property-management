import { describe, it, expect } from "vitest";
import { annualByKind, itemTaxes, taxFromBase, type TaxItem } from "../property-tax";

const item = (p: Partial<TaxItem>): TaxItem => ({
  kind: "land", label: null, fixedBase: null, cityBase: null, shareNum: 1, shareDen: 1, fixedTax: null, cityTax: null, ...p,
});

describe("課税標準額から税額(地方税法 20条の4の2: 標準額は千円未満・税額は百円未満を切り捨て)", () => {
  it("固定資産税 1.4%", () => {
    expect(taxFromBase(10_000_999, 1, 1, 140)).toBe(140_000);
    expect(taxFromBase(1_234_567, 1, 1, 140)).toBe(17_200);
  });
  it("都市計画税 0.3%", () => {
    expect(taxFromBase(1_234_567, 1, 1, 30)).toBe(3_700);
  });
  it("持分を掛けてから千円未満を切り捨てる", () => {
    // 50,000,000 × 1234/100000 = 617,000 → ×1.4% = 8,638 → 8,600
    expect(taxFromBase(50_000_000, 1234, 100_000, 140)).toBe(8_600);
    // 1,000,999 × 1/2 = 500,499.5 → 500,000 → ×1.4% = 7,000
    expect(taxFromBase(1_000_999, 1, 2, 140)).toBe(7_000);
  });
  it("千円未満だけなら 0", () => {
    expect(taxFromBase(999, 1, 1, 140)).toBe(0);
  });
});

describe("行の税額", () => {
  it("課税標準額が空なら自動の値は無し・税額は 0", () => {
    expect(itemTaxes(item({}))).toEqual({ fixedAuto: null, cityAuto: null, fixed: 0, city: 0 });
  });
  it("課税標準額から自動で出す", () => {
    expect(itemTaxes(item({ fixedBase: 1_234_567, cityBase: 1_234_567 }))).toEqual({ fixedAuto: 17_200, cityAuto: 3_700, fixed: 17_200, city: 3_700 });
  });
  it("手で入れた税額を使う(0 も手の値)", () => {
    const r = itemTaxes(item({ fixedBase: 1_234_567, cityBase: 1_234_567, fixedTax: 0, cityTax: 3_650 }));
    expect(r).toEqual({ fixedAuto: 17_200, cityAuto: 3_700, fixed: 0, city: 3_650 });
  });
  it("区分ごとに固+都を合計する", () => {
    const r = annualByKind([
      item({ kind: "land", fixedTax: 10_000, cityTax: 2_000 }),
      item({ kind: "land", fixedTax: 5_000, cityTax: 1_000 }),
      item({ kind: "building", fixedTax: 30_000, cityTax: 6_500 }),
    ]);
    expect(r).toEqual({ land: 18_000, building: 36_500 });
  });
});
