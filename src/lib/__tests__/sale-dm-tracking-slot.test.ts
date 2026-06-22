import { describe, it, expect } from "vitest";
import { renderTrackingSlotHtml } from "../sale-dm-letter/tracking-slot";

describe("renderTrackingSlotHtml", () => {
  const artifacts = { url: "https://app.example.com/t/abc123", qrSvg: "<svg><rect/></svg>" };

  it("QR(SVG)と短縮URLを含む", () => {
    const html = renderTrackingSlotHtml(artifacts);
    expect(html).toContain("<svg>");
    expect(html).toContain("https://app.example.com/t/abc123");
  });

  it("URL テキストは HTML エスケープされる(< > & を素で出さない)", () => {
    const html = renderTrackingSlotHtml({ url: "https://x.test/t/a&b<c>", qrSvg: "<svg/>" });
    expect(html).toContain("a&amp;b&lt;c&gt;");
    expect(html).not.toContain("a&b<c>");
  });

  it("案内文(任意 caption)を差し込める", () => {
    const html = renderTrackingSlotHtml(artifacts, { caption: "詳しくはこちら" });
    expect(html).toContain("詳しくはこちら");
  });
});
