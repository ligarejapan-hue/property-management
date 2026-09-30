import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/proxy";

describe("proxy public paths(通知 段階1)", () => {
  it("Service Worker・manifest・アイコンはログイン前にも読める", () => {
    expect(isPublicPath("/sw.js")).toBe(true);
    expect(isPublicPath("/manifest.webmanifest")).toBe(true);
    expect(isPublicPath("/icons/icon-192.png")).toBe(true);
  });

  it("近接パスは公開しない(完全一致・前方一致の範囲を広げない)", () => {
    expect(isPublicPath("/sw.jsx")).toBe(false);
    expect(isPublicPath("/sw.js/other")).toBe(false);
    expect(isPublicPath("/manifest.webmanifest.bak")).toBe(false);
    expect(isPublicPath("/icons")).toBe(false);
    expect(isPublicPath("/iconsx/a.png")).toBe(false);
  });
});
