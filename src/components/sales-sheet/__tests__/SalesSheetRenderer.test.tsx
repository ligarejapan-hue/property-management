import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "../SalesSheetRenderer";
import { sampleDocument } from "@/lib/sales-sheet/__fixtures__/sample-document";
import { A4_LANDSCAPE } from "@/lib/sales-sheet/document-schema";

describe("SalesSheetRenderer", () => {
  it("ページを relative・mm 寸法で描画する", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("position:relative");
    expect(html).toContain("width:297mm");
    expect(html).toContain("height:210mm");
  });

  it("各要素を絶対配置(mm)し、内容を含む", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("position:absolute");
    expect(html).toContain("left:10mm");
    expect(html).toContain("3,480万円");
    expect(html).toContain("リノベ済");
    expect(html).toContain("所在地");
  });

});

describe("SalesSheetRenderer — スキーマ検証で不正ドキュメントを拒否 (P2)", () => {
  /** コンポーネント入口で parseSalesSheetDocument を呼ぶため、
   *  スキーマ違反ドキュメントを渡すと ZodError がスローされる。
   *  sanitizeCssValue は有効なデータに対する多層防御として残存する（no-op になる）。 */

  it("theme.fontFamily に ; ペイロードが含まれていると ZodError でスローされる", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: {
        fontFamily: 'sans-serif;background-image:url(http://169.254.169.254/)',
        accentColor: "#000",
      },
      elements: [],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("text color に ; ペイロードが含まれていると ZodError でスローされる", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "t1", type: "text", x: 0, y: 0, w: 50, h: 10, z: 1,
          content: "test",
          style: { color: "red;background-image:url(http://169.254.169.254/)" },
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("badge bg に ; ペイロードが含まれていると ZodError でスローされる", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "b1", type: "badge", x: 0, y: 0, w: 30, h: 8, z: 1,
          label: "test",
          shape: "rounded",
          bg: "red;background-image:url(http://169.254.169.254/)",
          fg: "#fff",
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("table borderColor に ; ペイロードが含まれていると ZodError でスローされる", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "tbl1", type: "table", x: 0, y: 0, w: 80, h: 40, z: 1,
          rows: [{ label: "項目", value: "値" }],
          style: { borderColor: "#ccc;background-image:url(http://169.254.169.254/)" },
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("shape fill に ; ペイロードが含まれていると ZodError でスローされる", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "s1", type: "shape", x: 0, y: 0, w: 30, h: 10, z: 1,
          shape: "rect",
          fill: "blue;background-image:url(http://169.254.169.254/)",
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("サンプルドキュメントの正常な画像(data:image/)はそのまま描画される", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("data:image/png;base64,");
  });

  it("通常の価格色(#d0331a)は sanitize 後も保持される", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("#d0331a");
  });

  it("badge bg に url(http://169.254.169.254/) があると ZodError でスローされる (SSRF防止 P2)", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "b1", type: "badge", x: 10, y: 10, w: 30, h: 8, z: 1,
          label: "test",
          shape: "rounded",
          bg: "url(http://169.254.169.254/)",
          fg: "#fff",
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("image src に http://169.254.169.254/ があるとスローされる (preview-guard / SSRF防止)", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "img1", type: "image", x: 0, y: 0, w: 80, h: 60, z: 1,
          src: "http://169.254.169.254/",
          fit: "cover",
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });

  it("qr dataUrl が http:// で始まるとスローされる (preview-guard)", () => {
    const badDoc = {
      page: A4_LANDSCAPE,
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "qr1", type: "qr", x: 0, y: 0, w: 30, h: 30, z: 1,
          dataUrl: "http://169.254.169.254/metadata",
        },
      ],
    };
    expect(() => renderToStaticMarkup(<SalesSheetRenderer document={badDoc as never} />)).toThrow();
  });
});
