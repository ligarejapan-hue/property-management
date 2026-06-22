import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "../SalesSheetRenderer";
import { sampleDocument } from "@/lib/sales-sheet/__fixtures__/sample-document";

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
