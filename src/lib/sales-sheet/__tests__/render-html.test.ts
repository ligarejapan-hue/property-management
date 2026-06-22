import { describe, it, expect } from "vitest";
import { renderDocumentToHtml } from "../render-html";
import { sampleDocument } from "../__fixtures__/sample-document";
import { A4_LANDSCAPE, type SalesSheetDocument } from "../document-schema";

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

describe("renderDocumentToHtml — font-family XSSエスケープ (CSS breakout防止)", () => {
  /** fontFamilyに任意文字列を注入したドキュメントを直接構築（スキーマbypass）。 */
  function makeDocWithFontFamily(ff: string): SalesSheetDocument {
    return {
      page: A4_LANDSCAPE,
      theme: { fontFamily: ff, accentColor: "#000" },
      elements: [],
    };
  }

  it("XSSペイロード '</style><script>alert(1)</script>' はスキーマで拒否される", () => {
    // スキーマ許可リスト(isSafeFontFamily)が < > を含む値を拒否するため、描画前に throw する
    const malicious = '"Yu Gothic", </style><scrip' + 't>alert(1)</scrip' + 't>';
    expect(() => renderDocumentToHtml(makeDocWithFontFamily(malicious))).toThrow();
  });

  it("通常のfontFamily ('Meiryo' 等) は保持される", () => {
    const html = renderDocumentToHtml(sampleDocument);
    // サンプルフィクスチャのフォント名が出力に含まれること
    expect(html).toContain("Meiryo");
  });

  it("日本語フォント名を含むfontFamilyは保持される", () => {
    const ff = '"游ゴシック体","Yu Gothic",sans-serif';
    const html = renderDocumentToHtml(makeDocWithFontFamily(ff));
    // 游ゴシック体 は日本語文字を含むが正当な値として保持される
    expect(html).toContain("Yu Gothic");
  });

  it("中括弧 } によるCSSブレイクアウトはスキーマで拒否される", () => {
    // スキーマ許可リスト(isSafeFontFamily)が { } を含む値を拒否するため、描画前に throw する
    const malicious = 'sans-serif}body{color:red';
    expect(() => renderDocumentToHtml(makeDocWithFontFamily(malicious))).toThrow();
  });
});

describe("renderDocumentToHtml — スキーマ検証 (codex P2)", () => {
  it("検証を通っていない不正なdoc(危険なimage src)は描画時に弾く", () => {
    const bad = {
      page: { width: 297, height: 210, orientation: "landscape" },
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [{ id: "i", type: "image", x: 0, y: 0, w: 10, h: 10, z: 1, src: "http://169.254.169.254/" }],
    };
    // @ts-expect-error intentionally passing an unvalidated/unsafe document
    expect(() => renderDocumentToHtml(bad)).toThrow();
  });
});
