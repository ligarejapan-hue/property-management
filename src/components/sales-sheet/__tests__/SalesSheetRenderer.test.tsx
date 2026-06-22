import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "../SalesSheetRenderer";
import { sampleDocument } from "@/lib/sales-sheet/__fixtures__/sample-document";
import type { SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
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

describe("SalesSheetRenderer — CSS injection 防止 (P1)", () => {
  /** ; を除去することで CSS宣言注入が成立しないことを検証する。
   *  注入ベクタは `;` (宣言区切り)。除去後の文字列はプロパティ値として無害に埋め込まれる。 */

  it("theme.fontFamily に ; ペイロードが含まれていても ; が除去され注入不成立", () => {
    const maliciousDoc: SalesSheetDocument = {
      page: A4_LANDSCAPE,
      theme: {
        fontFamily: 'sans-serif;background-image:url(http://169.254.169.254/)',
        accentColor: "#000",
      },
      elements: [],
    };
    const html = renderToStaticMarkup(<SalesSheetRenderer document={maliciousDoc} />);
    // ; が除去されているので独立したCSSプロパティとして注入されていない
    expect(html).not.toContain('sans-serif;');
    // font-family 値の中に埋め込まれているだけ（無害）
    expect(html).toContain("sans-serifbackground-image");
  });

  it("text color に ; ペイロードが含まれていても ; が除去され注入不成立", () => {
    const maliciousDoc: SalesSheetDocument = {
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
    const html = renderToStaticMarkup(<SalesSheetRenderer document={maliciousDoc} />);
    // ; が除去されているので "color:red" から独立した background-image 宣言にならない
    expect(html).not.toContain("red;");
    expect(html).toContain("redbackground-image");
  });

  it("badge bg/fg に ; ペイロードが含まれていても ; が除去される", () => {
    const maliciousDoc: SalesSheetDocument = {
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
    const html = renderToStaticMarkup(<SalesSheetRenderer document={maliciousDoc} />);
    expect(html).not.toContain("red;");
    expect(html).toContain("redbackground-image");
  });

  it("table borderColor に ; ペイロードが含まれていても ; が除去される", () => {
    const maliciousDoc: SalesSheetDocument = {
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
    const html = renderToStaticMarkup(<SalesSheetRenderer document={maliciousDoc} />);
    expect(html).not.toContain("#ccc;");
    expect(html).toContain("#cccbackground-image");
  });

  it("shape fill に ; ペイロードが含まれていても ; が除去される", () => {
    const maliciousDoc: SalesSheetDocument = {
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
    const html = renderToStaticMarkup(<SalesSheetRenderer document={maliciousDoc} />);
    expect(html).not.toContain("blue;");
    expect(html).toContain("bluebackground-image");
  });

  it("サンプルドキュメントの正常な画像(data:image/)はそのまま描画される", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("data:image/png;base64,");
  });

  it("通常の価格色(#d0331a)は sanitize 後も保持される", () => {
    const html = renderToStaticMarkup(<SalesSheetRenderer document={sampleDocument} />);
    expect(html).toContain("#d0331a");
  });

  it("badge bg に url(http://169.254.169.254/) が含まれていても url( が除去される (SSRF防止)", () => {
    const maliciousDoc: SalesSheetDocument = {
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
    const html = renderToStaticMarkup(<SalesSheetRenderer document={maliciousDoc} />);
    expect(html).not.toContain("url(http");
    expect(html).not.toContain("url(http://169.254.169.254");
  });
});
