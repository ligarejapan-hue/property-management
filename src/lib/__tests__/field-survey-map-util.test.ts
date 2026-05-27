/**
 * 現地調査マップ UI (Phase 1-E) の純粋 helper のテスト。
 *  - bbox validation
 *  - query string 組み立て
 *  - debounce 動作
 *  - APIキー存在チェック
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateBbox,
  buildMapPropertiesQuery,
  debounce,
  isGoogleMapsKeyConfigured,
} from "@/lib/field-survey-map-util";

describe("validateBbox", () => {
  it("正常 bbox は ok", () => {
    expect(
      validateBbox({ north: 35.7, south: 35.6, east: 139.8, west: 139.7 }).ok,
    ).toBe(true);
  });

  it("非数値は out_of_range", () => {
    expect(
      validateBbox({
        north: Number.NaN,
        south: 35.6,
        east: 139.8,
        west: 139.7,
      }),
    ).toEqual({ ok: false, reason: "out_of_range" });
  });

  it("緯度範囲外 (>90) は out_of_range", () => {
    expect(
      validateBbox({ north: 91, south: 35.6, east: 139.8, west: 139.7 }),
    ).toEqual({ ok: false, reason: "out_of_range" });
  });

  it("経度範囲外 (<-180) は out_of_range", () => {
    expect(
      validateBbox({ north: 35.7, south: 35.6, east: 139.8, west: -181 }),
    ).toEqual({ ok: false, reason: "out_of_range" });
  });

  it("north < south は inverted_lat", () => {
    expect(
      validateBbox({ north: 35.5, south: 35.7, east: 139.8, west: 139.7 }),
    ).toEqual({ ok: false, reason: "inverted_lat" });
  });

  it("east < west は inverted_lng (日付変更線跨ぎ非対応)", () => {
    expect(
      validateBbox({ north: 35.7, south: 35.6, east: 139.7, west: 139.8 }),
    ).toEqual({ ok: false, reason: "inverted_lng" });
  });

  it("緯度差超過は too_large_lat", () => {
    expect(
      validateBbox({ north: 36.5, south: 35.6, east: 139.8, west: 139.7 }),
    ).toEqual({ ok: false, reason: "too_large_lat" });
  });

  it("経度差超過は too_large_lng", () => {
    expect(
      validateBbox({ north: 35.7, south: 35.6, east: 140.5, west: 139.7 }),
    ).toEqual({ ok: false, reason: "too_large_lng" });
  });
});

describe("buildMapPropertiesQuery", () => {
  it("bbox を 4 値で URLSearchParams にする", () => {
    const qs = buildMapPropertiesQuery({
      north: 35.7,
      south: 35.6,
      east: 139.8,
      west: 139.7,
    });
    const sp = new URLSearchParams(qs);
    expect(sp.get("north")).toBe("35.7");
    expect(sp.get("south")).toBe("35.6");
    expect(sp.get("east")).toBe("139.8");
    expect(sp.get("west")).toBe("139.7");
    expect(sp.get("limit")).toBeNull();
    expect(sp.get("includeArchived")).toBeNull();
  });

  it("limit / includeArchived option を含める", () => {
    const qs = buildMapPropertiesQuery(
      { north: 35.7, south: 35.6, east: 139.8, west: 139.7 },
      { limit: 50, includeArchived: true },
    );
    const sp = new URLSearchParams(qs);
    expect(sp.get("limit")).toBe("50");
    expect(sp.get("includeArchived")).toBe("true");
  });

  it("includeArchived=false は含めない", () => {
    const qs = buildMapPropertiesQuery(
      { north: 35.7, south: 35.6, east: 139.8, west: 139.7 },
      { includeArchived: false },
    );
    expect(new URLSearchParams(qs).get("includeArchived")).toBeNull();
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("連続呼び出しを 1 回に間引く (trailing)", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("c");
  });

  it("間隔を空けた呼び出しは複数回発火する", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    vi.advanceTimersByTime(100);
    d(2);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() で pending を取り消せる", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("isGoogleMapsKeyConfigured", () => {
  it("未設定 (undefined/null/empty/whitespace) は false", () => {
    expect(isGoogleMapsKeyConfigured(undefined)).toBe(false);
    expect(isGoogleMapsKeyConfigured(null)).toBe(false);
    expect(isGoogleMapsKeyConfigured("")).toBe(false);
    expect(isGoogleMapsKeyConfigured("   ")).toBe(false);
  });

  it("有効な文字列は true", () => {
    expect(isGoogleMapsKeyConfigured("AIza-xxx")).toBe(true);
  });
});
