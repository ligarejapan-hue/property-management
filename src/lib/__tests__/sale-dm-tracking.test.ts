import { describe, it, expect } from "vitest";
import { buildTrackingUrl, TRACKING_PATH_PREFIX, isInquiryResponded } from "../sale-dm-letter/tracking";

describe("buildTrackingUrl", () => {
  it("base 指定時は絶対URL(末尾スラッシュ重複なし)", () => {
    expect(buildTrackingUrl("abc123", "https://app.example.com")).toBe("https://app.example.com/t/abc123");
  });
  it("base 末尾スラッシュ付きでも二重スラッシュにしない", () => {
    expect(buildTrackingUrl("abc123", "https://app.example.com/")).toBe("https://app.example.com/t/abc123");
  });
  it("base 未指定なら相対パス", () => {
    expect(buildTrackingUrl("abc123")).toBe("/t/abc123");
  });
  it("token は encodeURIComponent される(URLにPII/危険文字を漏らさない)", () => {
    expect(buildTrackingUrl("a/b?c", "https://x.test")).toBe("https://x.test/t/a%2Fb%3Fc");
  });
  it("prefix は /t/", () => {
    expect(TRACKING_PATH_PREFIX).toBe("/t/");
  });
});

describe("isInquiryResponded", () => {
  it("LPアクセスありで true", () => {
    expect(isInquiryResponded({ lpFirstAccessAt: new Date(), phoneInquiryAt: null })).toBe(true);
  });
  it("電話ありで true", () => {
    expect(isInquiryResponded({ lpFirstAccessAt: null, phoneInquiryAt: new Date() })).toBe(true);
  });
  it("どちらも無ければ false", () => {
    expect(isInquiryResponded({ lpFirstAccessAt: null, phoneInquiryAt: null })).toBe(false);
  });
});
