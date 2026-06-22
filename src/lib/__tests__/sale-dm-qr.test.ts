import { describe, it, expect } from "vitest";
import { buildTrackingQrSvg, buildTrackingArtifacts } from "../sale-dm-letter/qr";

describe("buildTrackingQrSvg", () => {
  it("SVG マークアップ文字列を返す", async () => {
    const svg = await buildTrackingQrSvg("https://app.example.com/t/abc123");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
  it("同一URLで決定的(同じSVG)", async () => {
    const a = await buildTrackingQrSvg("https://x.test/t/tok");
    const b = await buildTrackingQrSvg("https://x.test/t/tok");
    expect(a).toBe(b);
  });
});

describe("buildTrackingArtifacts", () => {
  it("追跡URL と QR(SVG) をまとめて返す", async () => {
    const { url, qrSvg } = await buildTrackingArtifacts("abc123", "https://app.example.com");
    expect(url).toBe("https://app.example.com/t/abc123");
    expect(qrSvg).toContain("<svg");
  });
  it("URL に token のみ(QR の中身=URL であり PII を含まない)", async () => {
    const { url } = await buildTrackingArtifacts("opaqueToken", "https://x.test");
    expect(url).toBe("https://x.test/t/opaqueToken");
    expect(url).not.toContain("田中");
  });
});
