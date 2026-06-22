import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "@/components/sales-sheet/SalesSheetRenderer";
import type { SalesSheetDocument } from "./document-schema";

/**
 * font-family を <style> に埋め込む前に CSS/HTML ブレイクアウト文字を除去。
 * 正当な値("Yu Gothic UI","Meiryo",sans-serif 等)は保持。
 * < > { } ; : \ 等を削除し </style> や } によるブレイクアウトを防止。
 */
function sanitizeFontFamily(ff: string): string {
  return ff.replace(/[^A-Za-z0-9 ,\-_'"().　-ヿ一-鿿＀-￯]/g, "");
}

/**
 * document を、ブラウザ・サーバー共通の Renderer で完全なHTML文書に描画する。
 * 画面プレビューと出力を同一描画にして WYSIWYG を保証する。
 */
export function renderDocumentToHtml(doc: SalesSheetDocument): string {
  const body = renderToStaticMarkup(createElement(SalesSheetRenderer, { document: doc }));
  const safeFontFamily = sanitizeFontFamily(doc.theme.fontFamily);
  const css = [
    "*{margin:0;padding:0;box-sizing:border-box}",
    `html,body{width:${doc.page.width}mm;height:${doc.page.height}mm}`,
    `body{font-family:${safeFontFamily}}`,
    `@page{size:${doc.page.width}mm ${doc.page.height}mm;margin:0}`,
  ].join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
