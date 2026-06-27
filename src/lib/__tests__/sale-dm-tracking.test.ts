import { describe, it, expect, afterEach } from "vitest";
import { buildTrackingUrl, TRACKING_PATH_PREFIX, isInquiryResponded, resolveTrackingBaseUrl } from "../sale-dm-letter/tracking";

describe("resolveTrackingBaseUrl (郵送QRは絶対http(s)必須)", () => {
  const ENV = process.env;
  afterEach(() => { process.env = ENV; });
  const withBase = (v?: string) => {
    process.env = { ...ENV };
    if (v === undefined) delete process.env.SALE_DM_TRACKING_BASE_URL;
    else process.env.SALE_DM_TRACKING_BASE_URL = v;
    return resolveTrackingBaseUrl();
  };
  it("未設定なら undefined", () => { expect(withBase(undefined)).toBeUndefined(); });
  it("絶対 https/http はそのまま返す", () => {
    expect(withBase("https://dm.example.com")).toBe("https://dm.example.com");
    expect(withBase("http://dm.example.com")).toBe("http://dm.example.com");
  });
  it("scheme 無し(example.com)は undefined(郵送QRで機能しない)", () => { expect(withBase("example.com")).toBeUndefined(); });
  it("相対パス(/app)は undefined", () => { expect(withBase("/app")).toBeUndefined(); });
  it("非http(ftp://x)は undefined", () => { expect(withBase("ftp://x")).toBeUndefined(); });
});

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
