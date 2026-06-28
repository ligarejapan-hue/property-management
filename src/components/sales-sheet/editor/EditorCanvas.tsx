import type { CSSProperties } from "react";
import type { SalesSheetDocument, SalesSheetElement } from "@/lib/sales-sheet/document-schema";
import { SalesSheetRenderer } from "../SalesSheetRenderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorCanvasProps {
  document: SalesSheetDocument;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** z-index base for hit-box overlay — placed above all element z values. */
const HIT_BOX_Z_BASE = 1000;

function hitBoxStyle(el: SalesSheetElement, isSelected: boolean): CSSProperties {
  return {
    position: "absolute",
    left: `${el.x}mm`,
    top: `${el.y}mm`,
    width: `${el.w}mm`,
    height: `${el.h}mm`,
    zIndex: HIT_BOX_Z_BASE + el.z,
    cursor: "pointer",
    boxSizing: "border-box",
    // Selection ring: solid accent border + outer glow
    border: isSelected ? "2px solid #2563eb" : "2px solid transparent",
    outline: isSelected ? "1px solid #93c5fd" : "none",
    outlineOffset: "1px",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * EditorCanvas (Task E)
 *
 * Renders the SalesSheetRenderer as a visual preview layer (A4 paper in mm),
 * then overlays a transparent click-target div per element.
 *
 * - Click element hit-box → onSelect(id)
 * - Click paper background → onSelect(null)  [deselect]
 * - Selected element gets a blue highlight ring
 *
 * No "use client" needed — this component is always imported by SalesSheetEditor
 * which carries the "use client" boundary.
 */
export function EditorCanvas({ document, selectedId, onSelect }: EditorCanvasProps) {
  const { page, elements } = document;

  return (
    <div
      data-editor-canvas
      style={{
        position: "relative",
        width: `${page.width}mm`,
        height: `${page.height}mm`,
        boxShadow: "0 2px 16px rgba(0,0,0,0.18)",
        userSelect: "none",
      }}
      onClick={() => onSelect(null)}
    >
      {/* ── Visual preview (plan-① renderer, unmodified) ─────────────── */}
      <SalesSheetRenderer document={document} />

      {/* ── Per-element hit-box overlay ──────────────────────────────── */}
      {elements.map((el) => {
        const isSelected = el.id === selectedId;
        return (
          <div
            key={el.id}
            data-hit-box={el.id}
            data-selected={isSelected ? "true" : undefined}
            role="button"
            tabIndex={0}
            aria-label={`select element ${el.id}`}
            style={hitBoxStyle(el, isSelected)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(el.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(el.id);
              }
            }}
          />
        );
      })}
    </div>
  );
}

export default EditorCanvas;
