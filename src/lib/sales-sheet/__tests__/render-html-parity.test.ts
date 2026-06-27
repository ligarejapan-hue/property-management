/**
 * render-html-parity.test.ts — WYSIWYG ドリフト防止ガード
 *
 * render-html.ts (文字列シリアライザ) と SalesSheetRenderer (React コンポーネント) の
 * 出力が同一の意味的シグナルを含むことを継続的に検証する。
 *
 * 背景: Turbopack は react-dom/server を API route の静的バンドルグラフから
 * 排除するため、render-html.ts は string serializer として実装されている。
 * 将来 Plan 3 で react-dom/server をサーバーグラフ外 (standalone worker 等) に
 * 移動して単一レンダラに収束させるまで、このテストがドリフト検知の安全網となる。
 *
 * NOTE: react-dom/server はテスト環境 (node) では許可されているため、
 * SalesSheetRenderer の renderToStaticMarkup はここで使用できる。
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SalesSheetRenderer } from "@/components/sales-sheet/SalesSheetRenderer";
import { renderDocumentToHtml } from "../render-html";
import { sampleDocument } from "../__fixtures__/sample-document";

/**
 * 両レンダラが持つべき「意味的シグナル」のリスト。
 * 出力 HTML の attribute 名などの細かい形式差異 (camelCase vs kebab-case 等) は
 * 問わず、コンテンツ・構造・寸法が揃っていることだけを確認する。
 */
const KEY_SIGNALS = [
  // ページ寸法 (CSS)
  "297mm",
  "210mm",
  // 要素配置
  "position:absolute",
  // テキスト要素の内容
  "3,480万円",
  // テーブルラベル
  "所在地",
  // 画像 src (data: URI のみ許可)
  "data:image/png;base64,",
  // バッジラベル
  "リノベ済",
  // @page ルール (HTML ラッパー側)
  "@page",
];

describe("renderDocumentToHtml — SalesSheetRenderer パリティガード", () => {
  const serializerHtml = renderDocumentToHtml(sampleDocument);
  const rendererHtml = renderToStaticMarkup(
    createElement(SalesSheetRenderer, { document: sampleDocument }),
  );

  for (const signal of KEY_SIGNALS) {
    it(`両レンダラが "${signal}" を含む`, () => {
      expect(serializerHtml).toContain(signal);
      // SalesSheetRenderer は body 断片のみ生成するため @page は含まない
      if (signal !== "@page") {
        expect(rendererHtml).toContain(signal);
      }
    });
  }

  it("シリアライザ出力は完全な HTML 文書である", () => {
    expect(serializerHtml.startsWith("<!doctype html>")).toBe(true);
    expect(serializerHtml).toContain("</html>");
    expect(serializerHtml).toContain('charset="utf-8"');
  });

  it("Renderer 出力はページラッパー div を含む", () => {
    expect(rendererHtml).toContain("data-sales-sheet-page");
  });

  it("シリアライザはスキーマ検証でSSRFペイロードを拒否する", () => {
    const bad = {
      page: { width: 297, height: 210, orientation: "landscape" as const },
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "i1", type: "image" as const,
          x: 0, y: 0, w: 10, h: 10, z: 1,
          src: "http://169.254.169.254/",
          fit: "cover" as const,
        },
      ],
    };
    expect(() => renderDocumentToHtml(bad)).toThrow();
  });

  it("Renderer もスキーマ検証でSSRFペイロードを拒否する", () => {
    const bad = {
      page: { width: 297, height: 210, orientation: "landscape" as const },
      theme: { fontFamily: "sans-serif", accentColor: "#000" },
      elements: [
        {
          id: "i1", type: "image" as const,
          x: 0, y: 0, w: 10, h: 10, z: 1,
          src: "http://169.254.169.254/",
          fit: "cover" as const,
        },
      ],
    };
    expect(() => renderToStaticMarkup(createElement(SalesSheetRenderer, { document: bad }))).toThrow();
  });
});
