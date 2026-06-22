import { describe, it, expect } from "vitest";
import { isAllowedRequestUrl } from "../output";

describe("isAllowedRequestUrl (export network guard)", () => {
  it("data:/about:/blob: のみ許可する", () => {
    expect(isAllowedRequestUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedRequestUrl("about:blank")).toBe(true);
    expect(isAllowedRequestUrl("blob:http://localhost/x")).toBe(true);
  });
  it("http/https/file 等の外部取得を拒否する（SSRF防止）", () => {
    expect(isAllowedRequestUrl("http://169.254.169.254/latest")).toBe(false);
    expect(isAllowedRequestUrl("https://example.com/x.png")).toBe(false);
    expect(isAllowedRequestUrl("file:///etc/passwd")).toBe(false);
  });
});
