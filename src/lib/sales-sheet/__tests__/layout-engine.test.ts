import { describe, it, expect } from "vitest";
import { computeSpecSheetLayout } from "../layout-engine";
const A4W = 297, A4H = 210;
const base = { photoCount: 3, specRowCount: 30, hasFloorPlan: false, footerHeight: 24 };
const within = (r: {x:number;y:number;w:number;h:number}) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= A4W + 0.01 && r.y + r.h <= A4H + 0.01;

describe("computeSpecSheetLayout", () => {
  it("全要素がA4内、overviewと写真域が重ならない", () => {
    const L = computeSpecSheetLayout(base);
    for (const r of [L.catchBand, L.heading, L.price, L.overview, L.photoArea, L.company, L.companyDetails]) {
      expect(within(r), JSON.stringify(r)).toBe(true);
    }
    expect(L.overview.x).toBeGreaterThanOrEqual(L.photoArea.x + L.photoArea.w);
  });
  it("写真が少ないほど概要表が広い（写真0枚は表がほぼ全幅）", () => {
    const few = computeSpecSheetLayout({ ...base, photoCount: 0 });
    const many = computeSpecSheetLayout({ ...base, photoCount: 3 });
    expect(few.overview.w).toBeGreaterThan(many.overview.w);
    expect(few.photoArea.w).toBe(0);
  });
  it("行数が多いほど概要表フォントが小さい（5..9 pt）", () => {
    const dense = computeSpecSheetLayout({ ...base, specRowCount: 45 });
    const sparse = computeSpecSheetLayout({ ...base, specRowCount: 8 });
    expect(dense.overview.fontSizePt).toBeLessThanOrEqual(sparse.overview.fontSizePt);
    expect(dense.overview.fontSizePt).toBeGreaterThanOrEqual(5);
    expect(sparse.overview.fontSizePt).toBeLessThanOrEqual(9);
  });
  it("footerHeightを大きくするとメイン領域(overview.h)が縮む", () => {
    const tall = computeSpecSheetLayout({ ...base, footerHeight: 40 });
    expect(tall.overview.h).toBeLessThan(computeSpecSheetLayout(base).overview.h);
  });
  it("photoSlots は photoCount 個・各セルが photoArea 内", () => {
    const L = computeSpecSheetLayout({ ...base, photoCount: 2 });
    expect(L.photoSlots).toHaveLength(2);
    for (const s of L.photoSlots) {
      expect(s.x).toBeGreaterThanOrEqual(L.photoArea.x - 0.01);
      expect(s.x + s.w).toBeLessThanOrEqual(L.photoArea.x + L.photoArea.w + 0.01);
    }
  });
});
