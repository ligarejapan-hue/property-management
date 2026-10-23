import { describe, it, expect } from "vitest";
import { buildingPriceApportion, buildingTaxOf } from "../building-tax";
import { capitalGainsEstimate, CAPITAL_GAINS_NOTE, type CapitalGainsRates } from "../capital-gains";
import { INITIAL_RATE_TABLES } from "../../rate-tables";

const rates = INITIAL_RATE_TABLES.find((t) => t.kind === "capital_gains")!.content as CapitalGainsRates;

describe("建物消費税の按分(依頼書 3.4)", () => {
  it("家屋割合 = 家屋 ÷ (家屋 + 土地)", () => {
    const p = buildingPriceApportion(30_000_000, [{ building: 10_000_000, land: 20_000_000, shareNum: 1, shareDen: 1 }], 10000);
    expect(p).toBe(10_000_000);
    expect(buildingTaxOf(p!, 1000)).toBe(909_090);
  });
  it("筆ごとに 評価額×持分 を足す", () => {
    const rows = [
      { building: 8_000_000, land: 0, shareNum: 1, shareDen: 2 },
      { building: 0, land: 12_000_000, shareNum: 1, shareDen: 3 },
    ];
    // 家屋 4,000,000 ・ 土地 4,000,000 → 1/2
    expect(buildingPriceApportion(20_000_001, rows, 10000)).toBe(10_000_000);
  });
  it("土地の割合 50%(借地権など)", () => {
    const p = buildingPriceApportion(30_000_000, [{ building: 10_000_000, land: 20_000_000, shareNum: 1, shareDen: 1 }], 5000);
    expect(p).toBe(15_000_000);
    expect(buildingTaxOf(p!, 1000)).toBe(1_363_636);
  });
  it("評価額が無い・全部0なら計算できない(0で割らない)", () => {
    expect(buildingPriceApportion(30_000_000, [], 10000)).toBeNull();
    expect(buildingPriceApportion(30_000_000, [{ building: 0, land: 0, shareNum: 1, shareDen: 1 }], 10000)).toBeNull();
  });
});

describe("譲渡所得の目安(依頼書 3.7)", () => {
  const base = { salePrice: 50_000_000, acquisitionCost: 30_000_000, sellingCosts: 1_800_000, acquiredOn: "2015-04-01", saleDate: "2026-07-01", residentialDeduction: false };
  it("長期: 課税所得は千円未満・税額は税目ごとに百円未満を切り捨て", () => {
    const r = capitalGainsEstimate(base, rates);
    expect(r).toMatchObject({ gain: 18_200_000, taxable: 18_200_000, longTerm: true });
    expect(r.incomeTax).toBe(2_730_000);
    expect(r.reconstructionTax).toBe(57_300);
    expect(r.residentTax).toBe(910_000);
    expect(r.total).toBe(2_730_000 + 57_300 + 910_000);
    expect(r.note).toBe(CAPITAL_GAINS_NOTE);
  });
  it("取得費が分からないときは売却価格の5%", () => {
    const r = capitalGainsEstimate({ ...base, acquisitionCost: null }, rates);
    expect(r.acquisitionCost).toBe(2_500_000);
    expect(r.usedEstimatedCost).toBe(true);
  });
  it("売却年の1月1日時点で5年を超えれば長期・ちょうど5年は短期", () => {
    expect(capitalGainsEstimate({ ...base, acquiredOn: "2020-12-31" }, rates).longTerm).toBe(true);
    expect(capitalGainsEstimate({ ...base, acquiredOn: "2021-01-01" }, rates).longTerm).toBe(false);
  });
  it("居住用3,000万円控除・損なら0", () => {
    expect(capitalGainsEstimate({ ...base, residentialDeduction: true }, rates)).toMatchObject({ deduction: 18_200_000, taxable: 0, total: 0 });
    expect(capitalGainsEstimate({ ...base, acquisitionCost: 60_000_000 }, rates)).toMatchObject({ taxable: 0, total: 0 });
  });
});
