import { describe, it, expect } from "vitest";
import {
  computeConsumerLayout, tableRowHeightMm, type Rect,
  CONSUMER_PHOTO_ZONE, CONSUMER_FOOTER, CONSUMER_MAP_QR_SLOT,
} from "../layout-engine";

const W = 297, H = 210;
const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const contains = (outer: Rect, r: Rect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w + 1e-6 && r.y + r.h <= outer.y + outer.h + 1e-6;

describe("tableRowHeightMm", () => {
  it("行高 = 文字(mm)×1.35 + 上下余白", () => {
    expect(tableRowHeightMm(12, 1.2)).toBeCloseTo(8.115, 3);
  });
});

describe("computeConsumerLayout", () => {
  for (const detailRowCount of [0, 1, 12, 20, 26, 40]) {
    it(`詳細${detailRowCount}行: 用紙内・正の寸法・重なりなし`, () => {
      const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount });
      const all = [L.catchBand, L.catchCopy, L.kindTag, L.heading, L.price, L.mainTable, L.detailLeft, L.detailRight, L.salesPointsBand, L.salesPoints, L.footer, L.photoZone, L.mapQrSlot];
      for (const r of all) expect(inside(r)).toBe(true);
      expect(overlaps(L.catchCopy, L.kindTag)).toBe(false);
      for (const r of [L.heading, L.price, L.mainTable, L.detailLeft, L.detailRight, L.salesPointsBand, L.footer]) {
        expect(overlaps(L.photoZone, r)).toBe(false);
      }
      expect(overlaps(L.heading, L.price)).toBe(false);
      expect(overlaps(L.price, L.mainTable)).toBe(false);
      expect(overlaps(L.mainTable, L.detailLeft)).toBe(false);
      expect(overlaps(L.mainTable, L.detailRight)).toBe(false);
      expect(overlaps(L.detailLeft, L.detailRight)).toBe(false);
      expect(overlaps(L.detailLeft, L.salesPointsBand)).toBe(false);
      expect(overlaps(L.salesPointsBand, L.footer)).toBe(false);
      expect(contains(L.salesPointsBand, L.salesPoints)).toBe(true);
      expect(contains(L.footer, L.mapQrSlot)).toBe(true);
      expect(L.mainTable.fontSizePt).toBeGreaterThanOrEqual(11);
      expect(L.detailFontSizePt).toBeGreaterThanOrEqual(8);
    });
  }
  it("詳細0行/12行は最大の文字(12pt/10pt)で入る", () => {
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 0 })).toMatchObject({ overflow: false, detailFontSizePt: 10, mainTable: { fontSizePt: 12 } });
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 12 })).toMatchObject({ overflow: false, detailFontSizePt: 10, mainTable: { fontSizePt: 12 } });
  });
  it("詳細20行は主要12ptのまま詳細を8.5ptまで縮めて入る", () => {
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 20 })).toMatchObject({ overflow: false, detailFontSizePt: 8.5, mainTable: { fontSizePt: 12 } });
  });
  it("詳細26行は下限でも入らず overflow(主要11pt・詳細8pt)", () => {
    expect(computeConsumerLayout({ mainRowCount: 8, detailRowCount: 26 })).toMatchObject({ overflow: true, detailFontSizePt: 8, mainTable: { fontSizePt: 11 } });
  });
  it("詳細の左右は同じ高さ・同じ幅で横に並ぶ", () => {
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 12 });
    expect(L.detailLeft.y).toBe(L.detailRight.y);
    expect(L.detailLeft.h).toBe(L.detailRight.h);
    expect(L.detailLeft.w).toBeCloseTo(L.detailRight.w, 6);
    expect(L.detailRight.x).toBeGreaterThan(L.detailLeft.x + L.detailLeft.w);
  });
  it("写真枠・会社帯・地図QR枠は定数と同じ", () => {
    const L = computeConsumerLayout({ mainRowCount: 8, detailRowCount: 5 });
    expect(L.photoZone).toEqual(CONSUMER_PHOTO_ZONE);
    expect(L.footer).toEqual(CONSUMER_FOOTER);
    expect(L.mapQrSlot).toEqual(CONSUMER_MAP_QR_SLOT);
  });
});
