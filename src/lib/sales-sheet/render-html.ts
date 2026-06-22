import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "@/components/sales-sheet/SalesSheetRenderer";
import type { SalesSheetDocument } from "./document-schema";
import { parseSalesSheetDocument } from "./document-schema";
import { sanitizeCssValue } from "./css-safety";

/**
 * document を、ブラウザ・サーバー共通の Renderer で完全なHTML文書に描画する。
 * 画面プレビューと出力を同一描画にして WYSIWYG を保証する。
 */
export function renderDocumentToHtml(doc: SalesSheetDocument): string {
  const validDoc = parseSalesSheetDocument(doc); // 描画前にスキーマ検証(SSRF/XSSガードを必ず適用)
  const body = renderToStaticMarkup(createElement(SalesSheetRenderer, { document: validDoc }));
  const safeFontFamily = sanitizeCssValue(validDoc.theme.fontFamily);
  const css = [
    "*{margin:0;padding:0;box-sizing:border-box}",
    `html,body{width:${validDoc.page.width}mm;height:${validDoc.page.height}mm}`,
    `body{font-family:${safeFontFamily}}`,
    `@page{size:${validDoc.page.width}mm ${validDoc.page.height}mm;margin:0}`,
  ].join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
