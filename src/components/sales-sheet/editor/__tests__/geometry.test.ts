/**
 * geometry.ts — unit tests (plan-3 Task F)
 *
 * Tests the pure px↔mm conversion helpers.
 * env = node; no DOM, no Moveable, no component dependencies.
 */
import { describe, it, expect } from "vitest";
import { pxToMm, mmToViewportPx } from "../geometry";

/** 96 dpi: 96 / 25.4 (exact fraction) */
const MM_TO_PX = 96 / 25.4;

/** Editor default display zoom */
const DEFAULT_ZOOM = 0.75;

// ---------------------------------------------------------------------------
// pxToMm
// ---------------------------------------------------------------------------

describe("pxToMm", () => {
  it("converts viewport px to mm at DEFAULT_ZOOM (0.75)", () => {
    // 1 mm of screen space at 0.75 zoom occupies MM_TO_PX * 0.75 screen pixels
    const oneMmInViewportPx = MM_TO_PX * DEFAULT_ZOOM;
    expect(pxToMm(oneMmInViewportPx, MM_TO_PX, DEFAULT_ZOOM)).toBeCloseTo(1, 10);
  });

  it("converts viewport px to mm at zoom = 1 (full scale)", () => {
    expect(pxToMm(MM_TO_PX * 10, MM_TO_PX, 1)).toBeCloseTo(10, 10);
  });

  it("returns 0 for 0 px (zero input)", () => {
    expect(pxToMm(0, MM_TO_PX, DEFAULT_ZOOM)).toBe(0);
  });

  it("round-trips with mmToViewportPx at DEFAULT_ZOOM", () => {
    const mm = 42.5;
    const px = mmToViewportPx(mm, MM_TO_PX, DEFAULT_ZOOM);
    expect(pxToMm(px, MM_TO_PX, DEFAULT_ZOOM)).toBeCloseTo(mm, 10);
  });

  it("round-trips with mmToViewportPx at zoom = 1", () => {
    const mm = 100;
    const px = mmToViewportPx(mm, MM_TO_PX, 1);
    expect(pxToMm(px, MM_TO_PX, 1)).toBeCloseTo(mm, 10);
  });

  it("handles A4 landscape page width (297 mm) without drift", () => {
    const px = mmToViewportPx(297, MM_TO_PX, DEFAULT_ZOOM);
    expect(pxToMm(px, MM_TO_PX, DEFAULT_ZOOM)).toBeCloseTo(297, 5);
  });

  it("handles A4 landscape page height (210 mm) without drift", () => {
    const px = mmToViewportPx(210, MM_TO_PX, DEFAULT_ZOOM);
    expect(pxToMm(px, MM_TO_PX, DEFAULT_ZOOM)).toBeCloseTo(210, 5);
  });

  it("a larger zoom produces fewer mm per viewport px", () => {
    const px = 100;
    const mmAt50 = pxToMm(px, MM_TO_PX, 0.5);
    const mmAt100 = pxToMm(px, MM_TO_PX, 1.0);
    expect(mmAt50).toBeGreaterThan(mmAt100);
  });
});

// ---------------------------------------------------------------------------
// mmToViewportPx
// ---------------------------------------------------------------------------

describe("mmToViewportPx", () => {
  it("converts mm to viewport px at DEFAULT_ZOOM", () => {
    // 10 mm × (96/25.4) × 0.75 ≈ 28.346 px
    const expected = 10 * (96 / 25.4) * 0.75;
    expect(mmToViewportPx(10, MM_TO_PX, DEFAULT_ZOOM)).toBeCloseTo(expected, 5);
  });

  it("converts 1 mm to MM_TO_PX viewport px at zoom = 1", () => {
    expect(mmToViewportPx(1, MM_TO_PX, 1)).toBeCloseTo(MM_TO_PX, 10);
  });

  it("returns 0 for 0 mm (zero input)", () => {
    expect(mmToViewportPx(0, MM_TO_PX, DEFAULT_ZOOM)).toBe(0);
  });

  it("is the inverse of pxToMm", () => {
    const px = 150;
    const roundTripped = mmToViewportPx(pxToMm(px, MM_TO_PX, DEFAULT_ZOOM), MM_TO_PX, DEFAULT_ZOOM);
    expect(roundTripped).toBeCloseTo(px, 10);
  });

  it("a larger zoom produces more viewport px per mm", () => {
    const mm = 10;
    const at50 = mmToViewportPx(mm, MM_TO_PX, 0.5);
    const at100 = mmToViewportPx(mm, MM_TO_PX, 1.0);
    expect(at100).toBeGreaterThan(at50);
  });
});
