import type { CSSProperties } from "react";
import type {
  SalesSheetDocument,
  SalesSheetElement,
  TextElement,
  ImageElement,
  TableElement,
  BadgeElement,
  ShapeElement,
  QrElement,
} from "@/lib/sales-sheet/document-schema";
import { parseSalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import { sanitizeCssValue } from "@/lib/sales-sheet/css-safety";

const mm = (v: number) => `${v}mm`;

function boxStyle(el: SalesSheetElement): CSSProperties {
  return {
    position: "absolute",
    left: mm(el.x),
    top: mm(el.y),
    width: mm(el.w),
    height: mm(el.h),
    zIndex: el.z,
    overflow: "hidden",
    boxSizing: "border-box",
  };
}

function TextEl({ el }: { el: TextElement }) {
  const s = el.style;
  const style: CSSProperties = {
    ...boxStyle(el),
    fontSize: s.fontSizePt ? `${s.fontSizePt}pt` : undefined,
    fontFamily: s.fontFamily ? sanitizeCssValue(s.fontFamily) : undefined,
    color: s.color ? sanitizeCssValue(s.color) : undefined,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    textDecoration: s.underline ? "underline" : undefined,
    textAlign: s.align,
    lineHeight: s.lineHeight,
    whiteSpace: "pre-wrap",
  };
  return <div style={style}>{el.content}</div>;
}

function ImageEl({ el }: { el: ImageElement }) {
  return (
    <div style={{ ...boxStyle(el), borderRadius: el.radiusMm ? mm(el.radiusMm) : undefined }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={el.src}
        alt={el.alt ?? ""}
        style={{ width: "100%", height: "100%", objectFit: el.fit, display: "block" }}
      />
    </div>
  );
}

function TableEl({ el }: { el: TableElement }) {
  const s = el.style;
  const safeBorderColor = sanitizeCssValue(s.borderColor ?? "#cccccc");
  const border = `0.2mm solid ${safeBorderColor}`;
  const safeLabelColor = s.labelColor ? sanitizeCssValue(s.labelColor) : undefined;
  const safeValueColor = s.valueColor ? sanitizeCssValue(s.valueColor) : undefined;
  return (
    <table
      style={{
        ...boxStyle(el),
        borderCollapse: "collapse",
        tableLayout: "fixed",
        fontSize: s.fontSizePt ? `${s.fontSizePt}pt` : undefined,
      }}
    >
      <tbody>
        {el.rows.map((r, i) => (
          <tr key={i}>
            <td style={{ border, color: safeLabelColor, padding: "0.5mm 1mm", width: "32%", fontWeight: 600, verticalAlign: "top" }}>
              {r.label}
            </td>
            <td style={{ border, color: safeValueColor, padding: "0.5mm 1mm", verticalAlign: "top" }}>
              {r.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BadgeEl({ el }: { el: BadgeElement }) {
  const radius = el.shape === "pill" ? "999px" : el.shape === "rounded" ? "2mm" : "0";
  const style: CSSProperties = {
    ...boxStyle(el),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: sanitizeCssValue(el.bg),
    color: sanitizeCssValue(el.fg),
    borderRadius: radius,
    fontWeight: 700,
    fontSize: el.fontSizePt ? `${el.fontSizePt}pt` : undefined,
    clipPath: el.shape === "ribbon" ? "polygon(0 0,100% 0,92% 50%,100% 100%,0 100%)" : undefined,
  };
  return <div style={style}>{el.label}</div>;
}

function ShapeEl({ el }: { el: ShapeElement }) {
  const safeStroke = el.stroke ? sanitizeCssValue(el.stroke) : undefined;
  const safeFill = el.fill ? sanitizeCssValue(el.fill) : undefined;
  if (el.shape === "line") {
    return (
      <div
        style={{ ...boxStyle(el), background: safeStroke ?? "#000000", height: el.strokeWidthMm ? mm(el.strokeWidthMm) : "0.3mm" }}
      />
    );
  }
  return (
    <div
      style={{
        ...boxStyle(el),
        background: safeFill,
        border: safeStroke ? `${el.strokeWidthMm ?? 0.3}mm solid ${safeStroke}` : undefined,
        borderRadius: el.radiusMm ? mm(el.radiusMm) : undefined,
      }}
    />
  );
}

function QrEl({ el }: { el: QrElement }) {
  return (
    <div style={boxStyle(el)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={el.dataUrl} alt="QR" style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

function ElementView({ el }: { el: SalesSheetElement }) {
  switch (el.type) {
    case "text":
      return <TextEl el={el} />;
    case "image":
      return <ImageEl el={el} />;
    case "table":
      return <TableEl el={el} />;
    case "badge":
      return <BadgeEl el={el} />;
    case "shape":
      return <ShapeEl el={el} />;
    case "qr":
      return <QrEl el={el} />;
  }
}

export function SalesSheetRenderer({ document }: { document: SalesSheetDocument }) {
  const doc = parseSalesSheetDocument(document);
  const pageStyle: CSSProperties = {
    position: "relative",
    // Establish a stacking context so element z-indices are scoped to the page:
    // a stray negative z then paints above the page background (between background
    // and content) instead of disappearing behind it. Defense-in-depth alongside
    // the non-negative z guards in editor-document (sendToBack / setZ).
    isolation: "isolate",
    width: mm(doc.page.width),
    height: mm(doc.page.height),
    background: "#ffffff",
    fontFamily: sanitizeCssValue(doc.theme.fontFamily),
    overflow: "hidden",
  };
  return (
    <div data-sales-sheet-page style={pageStyle}>
      {doc.elements.map((el) => (
        <ElementView key={el.id} el={el} />
      ))}
    </div>
  );
}

export default SalesSheetRenderer;
