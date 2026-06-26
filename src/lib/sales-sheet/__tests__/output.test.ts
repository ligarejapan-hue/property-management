import { describe, it, expect } from "vitest";
import { isChromiumAvailable, renderHtmlToPdf, renderHtmlToImage } from "../output";

describe("output engine", () => {
  it("isChromiumAvailable は boolean を返す", () => {
    expect(typeof isChromiumAvailable()).toBe("boolean");
  });

  it.skipIf(!isChromiumAvailable())(
    "HTML→PDF / PNG のバッファを生成する",
    async () => {
      const html =
        '<!doctype html><html><body><div style="width:100mm;height:50mm;background:#eef">hello 図面</div></body></html>';
      const pdf = await renderHtmlToPdf(html, { widthMm: 100, heightMm: 50 });
      expect(pdf.length).toBeGreaterThan(0);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const png = await renderHtmlToImage(html, { format: "png" });
      expect(png.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
