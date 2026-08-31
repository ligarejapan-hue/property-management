import { describe, it, expect } from "vitest";
import { renderUnsubscribeSlotHtml } from "../sale-dm-letter/unsubscribe-slot";

// 配信停止QRの紙面断片。既存テンプレの追跡枠(trackingSlotHtml)に**連結**して差し込む
// (テンプレ本体は変更しない)。

describe("renderUnsubscribeSlotHtml", () => {
  const artifacts = {
    url: "https://app.example.com/u/abc.sig",
    qrSvg: "<svg><rect/></svg>",
  };

  it("QR(SVG)・URL・停止の案内文を含む", () => {
    const html = renderUnsubscribeSlotHtml(artifacts);
    expect(html).toContain("<svg>");
    expect(html).toContain("https://app.example.com/u/abc.sig");
    expect(html).toContain("配信停止");
  });

  it("URL テキストは HTML エスケープされる", () => {
    const html = renderUnsubscribeSlotHtml({
      url: "https://x.test/u/a&b<c>",
      qrSvg: "<svg/>",
    });
    expect(html).toContain("a&amp;b&lt;c&gt;");
    expect(html).not.toContain("a&b<c>");
  });

  it("追跡枠(無料査定QR)と見分けられる専用クラスを持つ", () => {
    const html = renderUnsubscribeSlotHtml(artifacts);
    expect(html).toContain("sale-dm-unsubscribe");
  });
});
