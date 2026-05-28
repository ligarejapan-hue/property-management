/**
 * Phase 1-F-3 現在地表示 UI 用 helper の単体テスト。
 *
 * - 副作用なし (navigator / fetch / storage を触らない)
 * - フォーマットが lat/lng を出力しない
 * - 低精度判定のしきい値が geolocation-util と一致する
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M,
  formatAccuracyMeters,
  formatLocationTime,
  isLowAccuracyForDisplay,
} from "@/lib/field-survey-current-location-util";
import { FIELD_SURVEY_ACCURACY_WARN_M } from "@/lib/field-survey-geolocation-util";

describe("CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M", () => {
  it("FIELD_SURVEY_ACCURACY_WARN_M (=100) と一致する", () => {
    expect(CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M).toBe(100);
    expect(CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M).toBe(
      FIELD_SURVEY_ACCURACY_WARN_M,
    );
  });
});

describe("formatLocationTime", () => {
  it("HH:MM:SS をゼロパディング付きで返す", () => {
    const d = new Date();
    d.setHours(3, 7, 9, 0);
    expect(formatLocationTime(d)).toBe("03:07:09");
  });

  it("通常の時刻を HH:MM:SS で返す", () => {
    const d = new Date();
    d.setHours(12, 34, 56, 0);
    expect(formatLocationTime(d)).toBe("12:34:56");
  });

  it("null / undefined / 無効 Date は — を返す", () => {
    expect(formatLocationTime(null)).toBe("—");
    expect(formatLocationTime(undefined)).toBe("—");
    expect(formatLocationTime(new Date("invalid"))).toBe("—");
  });
});

describe("formatAccuracyMeters", () => {
  it("整数 round した m 表記を返す", () => {
    expect(formatAccuracyMeters(103.4)).toBe("約103m");
    expect(formatAccuracyMeters(103.6)).toBe("約104m");
    expect(formatAccuracyMeters(0)).toBe("約0m");
    expect(formatAccuracyMeters(7)).toBe("約7m");
  });

  it("null / undefined / NaN / Infinity / 負数 は — を返す", () => {
    expect(formatAccuracyMeters(null)).toBe("—");
    expect(formatAccuracyMeters(undefined)).toBe("—");
    expect(formatAccuracyMeters(Number.NaN)).toBe("—");
    expect(formatAccuracyMeters(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatAccuracyMeters(-1)).toBe("—");
  });

  it("出力に lat / lng / 経緯 を含めない", () => {
    expect(formatAccuracyMeters(101)).not.toMatch(/lat|lng|°|N|S|E|W/i);
  });
});

describe("isLowAccuracyForDisplay", () => {
  it("100m 超なら true", () => {
    expect(isLowAccuracyForDisplay(101)).toBe(true);
    expect(isLowAccuracyForDisplay(150)).toBe(true);
  });

  it("100m 以下は false", () => {
    expect(isLowAccuracyForDisplay(100)).toBe(false);
    expect(isLowAccuracyForDisplay(50)).toBe(false);
    expect(isLowAccuracyForDisplay(0)).toBe(false);
  });

  it("null / undefined / NaN / Infinity は false", () => {
    expect(isLowAccuracyForDisplay(null)).toBe(false);
    expect(isLowAccuracyForDisplay(undefined)).toBe(false);
    expect(isLowAccuracyForDisplay(Number.NaN)).toBe(false);
    expect(isLowAccuracyForDisplay(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("threshold を override できる (将来の調整用)", () => {
    expect(isLowAccuracyForDisplay(60, 50)).toBe(true);
    expect(isLowAccuracyForDisplay(40, 50)).toBe(false);
  });
});
