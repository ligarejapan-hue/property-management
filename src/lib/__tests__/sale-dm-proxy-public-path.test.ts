import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/proxy";

describe("proxy public paths(/t/ 追跡リンク)", () => {
  it("/t/<token> は公開(認証不要)", () => {
    expect(isPublicPath("/t/abc123")).toBe(true);
    expect(isPublicPath("/t/")).toBe(true);
  });
  it("既存の公開パスは引き続き公開", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/session")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/uploads/x.pdf")).toBe(true);
  });
  it("/u/<token> は公開(配信停止QRの受け手は未認証)", () => {
    expect(isPublicPath("/u/abc.def")).toBe(true);
    expect(isPublicPath("/u/")).toBe(true);
  });
  it("/u/ に前方一致しない近接パスは公開しない", () => {
    expect(isPublicPath("/u")).toBe(false);
    expect(isPublicPath("/users")).toBe(false);
    expect(isPublicPath("/unsubscribe")).toBe(false);
  });
  it("/t/ に前方一致しない近接パスは公開しない(過剰公開の回帰防止)", () => {
    expect(isPublicPath("/tasks")).toBe(false);
    expect(isPublicPath("/team")).toBe(false);
    expect(isPublicPath("/api/properties")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });
  it("/lp-assets/<publicId> は公開(LP の写真は未認証の所有者が見る)", () => {
    expect(isPublicPath("/lp-assets/abcdef")).toBe(true);
    expect(isPublicPath("/lp-assets/")).toBe(true);
  });
  it("/lp-assets/ に前方一致しない近接パスは公開しない", () => {
    expect(isPublicPath("/lp-assets")).toBe(false);
    expect(isPublicPath("/lp")).toBe(false);
    expect(isPublicPath("/api/properties/sale-dm/lp-assets")).toBe(false);
  });
});
