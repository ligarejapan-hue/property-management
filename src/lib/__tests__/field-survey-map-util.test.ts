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
  isGoogleMapsBillingAcknowledged,
  isGoogleMapsMapIdConfigured,
  coerceFiniteNumber,
  coerceLat,
  coerceLng,
  coerceAccuracy,
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

describe("isGoogleMapsBillingAcknowledged", () => {
  it("未設定 / null / 空文字は false (デフォルトは未確認)", () => {
    expect(isGoogleMapsBillingAcknowledged(undefined)).toBe(false);
    expect(isGoogleMapsBillingAcknowledged(null)).toBe(false);
    expect(isGoogleMapsBillingAcknowledged("")).toBe(false);
    expect(isGoogleMapsBillingAcknowledged("   ")).toBe(false);
  });

  it("'true' (大文字小文字・前後空白含む) のみ true 扱い", () => {
    expect(isGoogleMapsBillingAcknowledged("true")).toBe(true);
    expect(isGoogleMapsBillingAcknowledged("True")).toBe(true);
    expect(isGoogleMapsBillingAcknowledged("TRUE")).toBe(true);
    expect(isGoogleMapsBillingAcknowledged("  true  ")).toBe(true);
  });

  it("'1' / 'yes' / 'on' などは安全側で false", () => {
    expect(isGoogleMapsBillingAcknowledged("1")).toBe(false);
    expect(isGoogleMapsBillingAcknowledged("yes")).toBe(false);
    expect(isGoogleMapsBillingAcknowledged("on")).toBe(false);
    expect(isGoogleMapsBillingAcknowledged("false")).toBe(false);
  });
});

describe("isGoogleMapsMapIdConfigured", () => {
  it("未設定 / null / 空文字 / whitespace は false", () => {
    expect(isGoogleMapsMapIdConfigured(undefined)).toBe(false);
    expect(isGoogleMapsMapIdConfigured(null)).toBe(false);
    expect(isGoogleMapsMapIdConfigured("")).toBe(false);
    expect(isGoogleMapsMapIdConfigured("   ")).toBe(false);
  });

  it("有効な文字列 (Map ID) は true", () => {
    expect(isGoogleMapsMapIdConfigured("abcd1234")).toBe(true);
    expect(isGoogleMapsMapIdConfigured("  abcd1234  ")).toBe(true);
  });
});

describe("coerceFiniteNumber (Codex P1: Decimal → number)", () => {
  it("finite number はそのまま返す", () => {
    expect(coerceFiniteNumber(35.6812)).toBe(35.6812);
    expect(coerceFiniteNumber(0)).toBe(0);
    expect(coerceFiniteNumber(-90)).toBe(-90);
  });

  it("数値 string は number に変換 (前後空白許容)", () => {
    expect(coerceFiniteNumber("35.6812")).toBe(35.6812);
    expect(coerceFiniteNumber("  -180  ")).toBe(-180);
    expect(coerceFiniteNumber("0")).toBe(0);
  });

  it("Decimal-like object (toString が数値) は変換可", () => {
    const decimalLike = {
      toString: () => "35.6812000",
    };
    expect(coerceFiniteNumber(decimalLike)).toBe(35.6812);
  });

  it("null / undefined / 空 / whitespace は null", () => {
    expect(coerceFiniteNumber(null)).toBeNull();
    expect(coerceFiniteNumber(undefined)).toBeNull();
    expect(coerceFiniteNumber("")).toBeNull();
    expect(coerceFiniteNumber("   ")).toBeNull();
  });

  it("NaN / Infinity / -Infinity / 非数値 string は null", () => {
    expect(coerceFiniteNumber(Number.NaN)).toBeNull();
    expect(coerceFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(coerceFiniteNumber(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(coerceFiniteNumber("abc")).toBeNull();
    expect(coerceFiniteNumber("12abc")).toBeNull();
  });

  it("通常 object ([object Object]) は null (Number 化で NaN)", () => {
    expect(coerceFiniteNumber({})).toBeNull();
    expect(coerceFiniteNumber({ foo: 1 })).toBeNull();
  });
});

describe("coerceLat (緯度: -90..90)", () => {
  it("範囲内は number で返す", () => {
    expect(coerceLat(35.6812)).toBe(35.6812);
    expect(coerceLat("35.6812")).toBe(35.6812);
    expect(coerceLat({ toString: () => "35.6812" })).toBe(35.6812);
    expect(coerceLat(-90)).toBe(-90);
    expect(coerceLat(90)).toBe(90);
  });

  it("範囲外 / 非数値 / null は null", () => {
    expect(coerceLat(90.0001)).toBeNull();
    expect(coerceLat(-90.0001)).toBeNull();
    expect(coerceLat(Number.NaN)).toBeNull();
    expect(coerceLat(null)).toBeNull();
    expect(coerceLat("abc")).toBeNull();
  });
});

describe("coerceLng (経度: -180..180)", () => {
  it("範囲内は number で返す", () => {
    expect(coerceLng(139.7671)).toBe(139.7671);
    expect(coerceLng("139.7671")).toBe(139.7671);
    expect(coerceLng({ toString: () => "139.7671" })).toBe(139.7671);
    expect(coerceLng(-180)).toBe(-180);
    expect(coerceLng(180)).toBe(180);
  });

  it("範囲外 / 非数値 / null は null", () => {
    expect(coerceLng(180.0001)).toBeNull();
    expect(coerceLng(-180.0001)).toBeNull();
    expect(coerceLng(Number.NaN)).toBeNull();
    expect(coerceLng(null)).toBeNull();
    expect(coerceLng("abc")).toBeNull();
  });
});

describe("coerceAccuracy (0 以上の有限数)", () => {
  it("0 以上は number", () => {
    expect(coerceAccuracy(0)).toBe(0);
    expect(coerceAccuracy(5)).toBe(5);
    expect(coerceAccuracy("12.34")).toBe(12.34);
    expect(coerceAccuracy({ toString: () => "8.5" })).toBe(8.5);
  });

  it("負値 / NaN / null は null", () => {
    expect(coerceAccuracy(-0.001)).toBeNull();
    expect(coerceAccuracy(Number.NaN)).toBeNull();
    expect(coerceAccuracy(null)).toBeNull();
    expect(coerceAccuracy("abc")).toBeNull();
  });
});
