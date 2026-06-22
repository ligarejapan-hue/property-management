import { describe, it, expect } from "vitest";
import { renderDocumentToHtml } from "../render-html";
import { sampleDocument } from "../__fixtures__/sample-document";

describe("renderDocumentToHtml", () => {
  it("完全なHTML文書を返す", () => {
    const html = renderDocumentToHtml(sampleDocument);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain('charset="utf-8"');
  });

  it("ページ寸法(@page)と要素内容を含む", () => {
    const html = renderDocumentToHtml(sampleDocument);
    expect(html).toContain("@page");
    expect(html).toContain("size:297mm 210mm");
    expect(html).toContain("3,480万円");
  });
});
