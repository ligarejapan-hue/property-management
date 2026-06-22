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

  it("XSSペイロード '</style><script>alert(1)</script>' をブレイクアウトさせない", () => {
    const malicious = '"Yu Gothic", </style><scrip' + 't>alert(1)</scrip' + 't>';
    const html = renderDocumentToHtml(makeDocWithFontFamily(malicious));
    // ブレイクアウト文字が除去されていること
    expect(html).not.toContain("</style><scrip");
    expect(html).not.toContain("<scrip");
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

  it("中括弧 } によるCSSブレイクアウトを防ぐ（<style>ブロック内）", () => {
    // 攻撃: font-family から抜け出して body{color:red} ルールを注入しようとする
    const malicious = 'sans-serif}body{color:red';
    const html = renderDocumentToHtml(makeDocWithFontFamily(malicious));
    // styleタグ内のCSSのみを抜き出してチェック
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const cssBlock = styleMatch![1];
    // { } が除去されているのでペイロードの {color:red} という独立ルールにならない
    expect(cssBlock).not.toContain("{color:red}");
    // ブレイクアウト文字 { } は除去されてfont-family値に埋め込まれているはず（: は無害なので残る）
    expect(cssBlock).toContain("sans-serifbodycolor:red");
  });
});
