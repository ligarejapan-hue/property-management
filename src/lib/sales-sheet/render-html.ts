import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesSheetRenderer } from "@/components/sales-sheet/SalesSheetRenderer";
import type { SalesSheetDocument } from "./document-schema";

/**
 * document を、ブラウザ・サーバー共通の Renderer で完全なHTML文書に描画する。
 * 画面プレビューと出力を同一描画にして WYSIWYG を保証する。
 */
export function renderDocumentToHtml(doc: SalesSheetDocument): string {
  const body = renderToStaticMarkup(createElement(SalesSheetRenderer, { document: doc }));
  const css = [
    "*{margin:0;padding:0;box-sizing:border-box}",
    `html,body{width:${doc.page.width}mm;height:${doc.page.height}mm}`,
    `body{font-family:${doc.theme.fontFamily}}`,
    `@page{size:${doc.page.width}mm ${doc.page.height}mm;margin:0}`,
  ].join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
