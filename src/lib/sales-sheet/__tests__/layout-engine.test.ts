import { describe, it, expect } from "vitest";
import { computeSpecSheetLayout, type Rect } from "../layout-engine";
const A4W = 297, A4H = 210;
const base = { photoCount: 3, specRowCount: 30, hasFloorPlan: false, footerHeight: 24 };
const within = (r: {x:number;y:number;w:number;h:number}) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= A4W + 0.01 && r.y + r.h <= A4H + 0.01;
/** 2矩形が重なっているか（辺が接するだけ＝境界共有は重なりとしない）。 */
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe("computeSpecSheetLayout — 3列構成（写真/間取り図/概要表）", () => {
  it("hasFloorPlan:true で間取り図は中央列（写真域の右・概要表の左）", () => {
    const L = computeSpecSheetLayout({ ...base, hasFloorPlan: true });
    const fp = L.floorPlan as Rect;
    // 中央列: 写真域の右端より右、概要表の左端より左（3つの列が左→中→右）。
    expect(fp.x).toBeGreaterThanOrEqual(L.photoArea.x + L.photoArea.w); // 写真域の右
    expect(fp.x + fp.w).toBeLessThanOrEqual(L.overview.x + 0.01); // 概要表の左
    // 縦は写真帯と同じ範囲（上端=写真域上端）＝図の下に写真を敷かない。
    expect(fp.y).toBeCloseTo(L.photoArea.y, 5);
    expect(fp.h).toBeGreaterThan(50); // 従来の小さな間取り枠(18mm)でなく列いっぱいの高さ
    expect(within(fp)).toBe(true);
  });

  it("間取り図があると写真域が左へ狭まる（反比例の土台）", () => {
    const no = computeSpecSheetLayout({ ...base, hasFloorPlan: false });
    const yes = computeSpecSheetLayout({ ...base, hasFloorPlan: true });
    expect(yes.photoArea.w).toBeLessThan(no.photoArea.w); // 図がある方が写真域は狭い
    expect(yes.photoArea.x).toBeCloseTo(no.photoArea.x, 5); // 左端は不変
  });

  it("写真スロットは中央列(間取り図)と重ならない", () => {
    const L = computeSpecSheetLayout({ ...base, hasFloorPlan: true, photoCount: 3 });
    const fp = L.floorPlan as Rect;
    for (const s of L.photoSlots) expect(overlaps(fp, s)).toBe(false);
  });
});

describe("computeSpecSheetLayout", () => {
  it("全要素がA4内、overviewと写真域が重ならない", () => {
    const L = computeSpecSheetLayout(base);
    for (const r of [L.catchBand, L.heading, L.price, L.overview, L.photoArea, L.company, L.companyDetails, L.footer]) {
      expect(within(r), JSON.stringify(r)).toBe(true);
    }
    expect(L.overview.x).toBeGreaterThanOrEqual(L.photoArea.x + L.photoArea.w);
  });
  it("footer は company と同じ原点/全幅・高さは footerHeight そのもの（[Task3] 会社帯の領域）", () => {
    const L = computeSpecSheetLayout(base);
    expect(L.footer).toEqual({ x: L.company.x, y: L.company.y, w: L.company.w, h: base.footerHeight });
    expect(overlaps(L.footer, L.salesPoints), "salesPoints と重なっている").toBe(false);
  });
  it("概要表（物件種別）の幅は写真枚数によらず右端から最大 1/3（要件⑤）", () => {
    // A4横 297mm の 1/3 = 99mm を上限に、概要表は右 1/3 以内・写真域が左側の残りを使う。
    const maxOverviewW = A4W / 3 + 0.01;
    for (const photoCount of [0, 1, 2, 3]) {
      const L = computeSpecSheetLayout({ ...base, photoCount });
      expect(L.overview.w, `photoCount=${photoCount}`).toBeLessThanOrEqual(maxOverviewW);
      // 写真域は左 2/3 側（概要表の左端より左）。
      expect(L.overview.x).toBeGreaterThanOrEqual(L.photoArea.x + L.photoArea.w);
    }
    expect(computeSpecSheetLayout({ ...base, photoCount: 0 }).photoSlots).toHaveLength(0);
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

describe("computeSpecSheetLayout — floorPlan（間取り図）の重なり回避 [@review Fix1]", () => {
  it.each([0, 1, 2, 3])(
    "hasFloorPlan:true・photoCount=%i で floorPlan が overview/heading/price/写真スロットのいずれとも重ならない",
    (photoCount) => {
      const L = computeSpecSheetLayout({ ...base, photoCount, hasFloorPlan: true });
      expect(L.floorPlan).not.toBeNull();
      const floorPlan = L.floorPlan as Rect;
      expect(overlaps(floorPlan, L.overview), "overview と重なっている").toBe(false);
      expect(overlaps(floorPlan, L.heading), "heading と重なっている").toBe(false);
      expect(overlaps(floorPlan, L.price), "price と重なっている").toBe(false);
      for (const slot of L.photoSlots) {
        expect(overlaps(floorPlan, slot), "写真スロットと重なっている").toBe(false);
      }
    },
  );
});

describe("computeSpecSheetLayout — salesPoints（セールスポイント帯）の重なり回避 [@review Fix A]", () => {
  it.each([
    [0, false],
    [1, false],
    [2, false],
    [3, false],
    [0, true],
    [1, true],
    [2, true],
    [3, true],
  ])(
    "photoCount=%i・hasFloorPlan=%s で salesPoints が overview / 写真スロットのいずれとも重ならない",
    (photoCount, hasFloorPlan) => {
      const L = computeSpecSheetLayout({ ...base, photoCount, hasFloorPlan });
      expect(overlaps(L.salesPoints, L.overview), "overview と重なっている").toBe(false);
      for (const slot of L.photoSlots) {
        expect(overlaps(L.salesPoints, slot), "写真スロットと重なっている").toBe(false);
      }
    },
  );
});
