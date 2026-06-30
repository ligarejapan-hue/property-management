import type { SalesSheetDocument, SalesSheetElement } from "./document-schema";
import { parseSalesSheetDocument } from "./document-schema";
import { sanitizeCssValue } from "./css-safety";

/**
 * document を完全なHTML文書に直列化する。
 * react-dom/server を避けて純関数でHTML文字列を生成することで、
 * Next.js App Router の react-server バンドルグラフと互換性を保つ。
 *
 * WYSIWYG 保証: SalesSheetRenderer との出力一致は
 * render-html-parity.test.ts のパリティガードテストで継続的に検証する。
 * Plan 3 では react-dom/server をサーバー外 (standalone script / worker) に移動し
 * 単一レンダラに収束させることを推奨する。
 */

function mm(v: number): string {
  return `${v}mm`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineStyle(pairs: Record<string, string | undefined | null>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

function boxStyle(el: SalesSheetElement): Record<string, string> {
  return {
    position: "absolute",
    left: mm(el.x),
    top: mm(el.y),
    width: mm(el.w),
    height: mm(el.h),
    "z-index": String(el.z),
    overflow: "hidden",
    "box-sizing": "border-box",
  };
}

function renderElement(el: SalesSheetElement): string {
  if (el.type === "text") {
    const s = el.style;
    const style = inlineStyle({
      ...boxStyle(el),
      "font-size": s.fontSizePt ? `${s.fontSizePt}pt` : null,
      "font-family": s.fontFamily ? sanitizeCssValue(s.fontFamily) : null,
      color: s.color ? sanitizeCssValue(s.color) : null,
      "font-weight": s.bold ? "700" : null,
      "font-style": s.italic ? "italic" : null,
      "text-decoration": s.underline ? "underline" : null,
      "text-align": s.align ?? null,
      "line-height": s.lineHeight != null ? String(s.lineHeight) : null,
      "white-space": "pre-wrap",
    });
    return `<div style="${esc(style)}">${esc(el.content)}</div>`;
  }

  if (el.type === "image") {
    const containerStyle = inlineStyle({
      ...boxStyle(el),
      "border-radius": el.radiusMm ? mm(el.radiusMm) : null,
    });
    const imgStyle = inlineStyle({ width: "100%", height: "100%", "object-fit": el.fit, display: "block" });
    return `<div style="${esc(containerStyle)}"><img src="${esc(el.src)}" alt="${esc(el.alt ?? "")}" style="${esc(imgStyle)}"/></div>`;
  }

  if (el.type === "table") {
    const s = el.style;
    const safeBorderColor = sanitizeCssValue(s.borderColor ?? "#cccccc");
    const border = `0.2mm solid ${safeBorderColor}`;
    const safeLabelColor = s.labelColor ? sanitizeCssValue(s.labelColor) : null;
    const safeValueColor = s.valueColor ? sanitizeCssValue(s.valueColor) : null;
    const tableStyle = inlineStyle({
      ...boxStyle(el),
      "border-collapse": "collapse",
      "table-layout": "fixed",
      "font-size": s.fontSizePt ? `${s.fontSizePt}pt` : null,
    });
    const rows = el.rows.map((r) => {
      const tdLabelStyle = inlineStyle({ border, color: safeLabelColor, padding: "0.5mm 1mm", width: "32%", "font-weight": "600", "vertical-align": "top" });
      const tdValueStyle = inlineStyle({ border, color: safeValueColor, padding: "0.5mm 1mm", "vertical-align": "top" });
      return `<tr><td style="${esc(tdLabelStyle)}">${esc(r.label)}</td><td style="${esc(tdValueStyle)}">${esc(r.value)}</td></tr>`;
    }).join("");
    return `<table style="${esc(tableStyle)}"><tbody>${rows}</tbody></table>`;
  }

  if (el.type === "badge") {
    const radius = el.shape === "pill" ? "999px" : el.shape === "rounded" ? "2mm" : "0";
    const clipPath = el.shape === "ribbon" ? "polygon(0 0,100% 0,92% 50%,100% 100%,0 100%)" : null;
    const style = inlineStyle({
      ...boxStyle(el),
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      background: sanitizeCssValue(el.bg),
      color: sanitizeCssValue(el.fg),
      "border-radius": radius,
      "font-weight": "700",
      "font-size": el.fontSizePt ? `${el.fontSizePt}pt` : null,
      "clip-path": clipPath,
    });
    return `<div style="${esc(style)}">${esc(el.label)}</div>`;
  }

  if (el.type === "shape") {
    const safeStroke = el.stroke ? sanitizeCssValue(el.stroke) : null;
    const safeFill = el.fill ? sanitizeCssValue(el.fill) : null;
    if (el.shape === "line") {
      const style = inlineStyle({
        ...boxStyle(el),
        background: safeStroke ?? "#000000",
        height: el.strokeWidthMm ? mm(el.strokeWidthMm) : "0.3mm",
      });
      return `<div style="${esc(style)}"></div>`;
    }
    const style = inlineStyle({
      ...boxStyle(el),
      background: safeFill,
      border: safeStroke ? `${el.strokeWidthMm ?? 0.3}mm solid ${safeStroke}` : null,
      "border-radius": el.radiusMm ? mm(el.radiusMm) : null,
    });
    return `<div style="${esc(style)}"></div>`;
  }

  if (el.type === "qr") {
    const style = inlineStyle(boxStyle(el));
    const imgStyle = inlineStyle({ width: "100%", height: "100%", display: "block" });
    return `<div style="${esc(style)}"><img src="${esc(el.dataUrl)}" alt="QR" style="${esc(imgStyle)}"/></div>`;
  }

  return "";
}

export function renderDocumentToHtml(doc: SalesSheetDocument): string {
  const validDoc = parseSalesSheetDocument(doc);
  const safeFontFamily = sanitizeCssValue(validDoc.theme.fontFamily);

  const pageStyle = inlineStyle({
    position: "relative",
    // Stacking context: scope element z-indices to the page so a stray negative z
    // paints above the page background instead of disappearing behind it (parity
    // with SalesSheetRenderer; defense alongside the non-negative-z save guard).
    isolation: "isolate",
    width: mm(validDoc.page.width),
    height: mm(validDoc.page.height),
    background: "#ffffff",
    "font-family": safeFontFamily,
    overflow: "hidden",
  });

  const elements = validDoc.elements.map(renderElement).join("");
  const body = `<div data-sales-sheet-page style="${esc(pageStyle)}">${elements}</div>`;

  const css = [
    "*{margin:0;padding:0;box-sizing:border-box}",
    `html,body{width:${validDoc.page.width}mm;height:${validDoc.page.height}mm}`,
    `body{font-family:${esc(safeFontFamily)}}`,
    `@page{size:${validDoc.page.width}mm ${validDoc.page.height}mm;margin:0}`,
  ].join("");

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
