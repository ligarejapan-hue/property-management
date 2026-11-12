import { describe, it, expect } from "vitest";
import {
  assessmentsSchema, costsSchema, settlementTermsSchema, leaseSchema, overridesSchema, dealUpdateSchema,
  DEFAULT_ASSESSMENTS, DEFAULT_COSTS, DEFAULT_TERMS,
} from "../schemas";
import { readAssessments, readCosts, readLeases, readOverrides, readTerms } from "../inputs";

const lease = {
  room: "101", tenant: "試験 次郎", contractType: "ordinary", period: "2025-04-01〜2027-03-31",
  rent: 80_000, commonFee: 5_000, parking: 0, other: 0, deposit: 160_000, arrears: false, arrearsAmount: 0, manager: "試験管理",
};

describe("段2の入力の検証", () => {
  it("初期値は検証を通る", () => {
    expect(assessmentsSchema.parse(DEFAULT_ASSESSMENTS)).toEqual(DEFAULT_ASSESSMENTS);
    expect(costsSchema.parse(DEFAULT_COSTS)).toEqual(DEFAULT_COSTS);
    expect(settlementTermsSchema.parse(DEFAULT_TERMS)).toEqual(DEFAULT_TERMS);
    expect(leaseSchema.parse(lease)).toEqual(lease);
  });
  it("持分は分子≦分母・金額は0以上の整数", () => {
    expect(() => assessmentsSchema.parse({ rows: [{ building: 1, land: 1, shareNum: 3, shareDen: 2 }], landRatioBp: 10000 })).toThrow();
    expect(() => leaseSchema.parse({ ...lease, rent: -1 })).toThrow();
    expect(() => leaseSchema.parse({ ...lease, rent: 1.5 })).toThrow();
  });
  it("上書きは決まった鍵だけ・一部だけでよい", () => {
    expect(overridesSchema.parse({ brokerageFee: 900_000 })).toEqual({ brokerageFee: 900_000 });
    expect(() => overridesSchema.parse({ price: 1 })).toThrow();
  });
  it("更新で金額・税率・段2の入力を送れる", () => {
    const v = dealUpdateSchema.parse({ version: 1, price: 30_000_000, deposit: 1_500_000, taxRateBp: 1000, leases: [lease], overrides: {} });
    expect(v).toMatchObject({ price: 30_000_000, deposit: 1_500_000, taxRateBp: 1000 });
    expect(() => dealUpdateSchema.parse({ version: 1, taxRateBp: 10001 })).toThrow();
  });
});

describe("精算の固都税(土地・建物ごと)", () => {
  const row = { kind: "land", label: "1番", fixedBase: 1_000_000, cityBase: 1_000_000, shareNum: 1, shareDen: 1, fixedTax: null, cityTax: null };
  it("新しい取引の初期値は土地・建物ごと・課税業者は未設定", () => {
    expect(DEFAULT_TERMS).toMatchObject({ taxInputMode: "items", taxItems: [], sellerTaxable: null });
  });
  it("年税額だけが保存された今の取引は「合計額だけ」として読む", () => {
    const t = readTerms({ fixedAssetTax: 120_000, cityPlanningTax: 30_000 });
    expect(t).toMatchObject({ taxInputMode: "total", fixedAssetTax: 120_000, cityPlanningTax: 30_000, taxItems: [] });
    expect(readTerms({ fixedAssetTax: null, cityPlanningTax: 30_000 }).taxInputMode).toBe("total");
  });
  it("年税額が両方空の今の取引は土地・建物ごと", () => {
    expect(readTerms({ fixedAssetTax: null, cityPlanningTax: null }).taxInputMode).toBe("items");
  });
  it("行を読み戻せる", () => {
    const t = readTerms({ taxInputMode: "items", taxItems: [row], sellerTaxable: true });
    expect(t.taxItems).toEqual([row]);
    expect(t.sellerTaxable).toBe(true);
  });
  it("持分は分子≦分母・分母は1以上", () => {
    const ok = (r: object) => settlementTermsSchema.safeParse({ ...DEFAULT_TERMS, taxItems: [{ ...row, ...r }] }).success;
    expect(ok({})).toBe(true);
    expect(ok({ shareNum: 2, shareDen: 1 })).toBe(false);
    expect(ok({ shareDen: 0 })).toBe(false);
    expect(ok({ kind: "parking" })).toBe(false);
  });
  it("手で直す鍵に土地・建物・建物分の消費税がある", () => {
    expect(readOverrides({ "settlement.propertyTaxLand": 1, "settlement.propertyTaxBuilding": 2, "settlement.propertyTaxBuildingVat": 3 }))
      .toEqual({ "settlement.propertyTaxLand": 1, "settlement.propertyTaxBuilding": 2, "settlement.propertyTaxBuildingVat": 3 });
  });
});

describe("保存済みの JSON を読む", () => {
  it("壊れていれば初期値・段1の初期値(空の配列や空の object)も読める", () => {
    expect(readAssessments([])).toEqual(DEFAULT_ASSESSMENTS);
    expect(readAssessments({ rows: [{ building: 1, land: 2, shareNum: 1, shareDen: 1 }] })).toEqual({ rows: [{ building: 1, land: 2, shareNum: 1, shareDen: 1 }], landRatioBp: 10000 });
    expect(readCosts({})).toEqual(DEFAULT_COSTS);
    expect(readTerms({ taxStart: "04-01" })).toEqual({ ...DEFAULT_TERMS, taxStart: "04-01" });
    expect(readTerms({ taxStart: "07-01" })).toEqual(DEFAULT_TERMS);
    expect(readLeases([lease, { room: 1 }])).toEqual([lease]);
    expect(readLeases({})).toEqual([]);
    expect(readOverrides({ brokerageFee: 1, bad: 2 })).toEqual({ brokerageFee: 1 });
  });
});
