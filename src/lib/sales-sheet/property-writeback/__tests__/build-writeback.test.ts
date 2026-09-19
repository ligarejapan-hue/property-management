import { describe, it, expect } from "vitest";
import { buildWriteback } from "../build-writeback";

const emptyCurrent = { property: {}, building: null };

describe("buildWriteback — 土地", () => {
  it("価格・交通・土地面積・計測方式を物件へ", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "3480", access: "○○線 徒歩8分", landArea: "125.30", areaMethod: "実測" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({
      salePrice: 3480,
      access: "○○線 徒歩8分",
      landArea: 125.3,
      landAreaMethod: "実測",
    });
    expect(r.building).toEqual({});
    expect(r.unreadable).toEqual([]);
  });

  it("今の値と同じ欄は入れない", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "3480", access: "○○線 徒歩8分" },
      current: { property: { salePrice: 3480, access: "○○線 徒歩8分" }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("空欄は変更なし(消さない)", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "", access: "   " },
      current: { property: { salePrice: 3480 }, building: null },
    });
    expect(r.property).toEqual({});
  });

  it("読み取れない値は保存せずラベルを返す", () => {
    const r = buildWriteback({
      kind: "land",
      values: { price: "応談", areaMethod: "だいたい" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["価格", "面積計測方式"]);
  });
});

describe("buildWriteback — 戸建", () => {
  it("築年月は年と月に分ける", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "平成20年3月", structure: "木造", aboveFloors: "2", parking: "有" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({
      builtYear: 2008,
      builtMonth: 3,
      structureType: "木造",
      aboveFloors: 2,
      parking: "有",
    });
  });

  it("読み取れない築年月は保存しない", () => {
    const r = buildWriteback({
      kind: "house",
      values: { builtYearMonth: "築15年" },
      current: emptyCurrent,
    });
    expect(r.property).toEqual({});
    expect(r.unreadable).toEqual(["築年月"]);
  });
});

describe("buildWriteback — 区分マンション", () => {
  it("部屋の欄は物件・棟の欄は棟へ", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: {
        price: "6590",
        exclusiveArea: "67.21",
        managementFee: "12800",
        structure: "RC",
        totalFloors: "11",
        totalUnits: "48",
        builtYearMonth: "2008年3月",
      },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({ salePrice: 6590, exclusiveArea: 67.21, managementFee: 12800 });
    expect(r.building).toEqual({
      structureType: "RC",
      totalFloors: 11,
      totalUnits: 48,
      builtYear: 2008,
      builtMonth: 3,
    });
  });

  it("棟が無い区分では棟の欄を捨てる", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { price: "6590", structure: "RC" },
      current: { property: {}, building: null },
    });
    expect(r.property).toEqual({ salePrice: 6590 });
    expect(r.building).toEqual({});
  });
});

describe("buildWriteback — 一棟", () => {
  it("棟には書かず物件へ(総戸数・利回り・満室想定収入を含む)", () => {
    const r = buildWriteback({
      kind: "building",
      values: { totalUnits: "24", grossYield: "8.5", expectedIncome: "9800", structure: "RC" },
      current: { property: {}, building: {} },
    });
    expect(r.property).toEqual({
      totalUnits: 24,
      grossYield: 8.5,
      expectedIncome: 9800,
      structureType: "RC",
    });
    expect(r.building).toEqual({});
  });
});
