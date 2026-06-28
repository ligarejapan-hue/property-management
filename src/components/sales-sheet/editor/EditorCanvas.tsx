"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { OnDrag, OnDragEnd, OnResize, OnResizeEnd, MoveableProps } from "react-moveable";
import type { SalesSheetDocument, SalesSheetElement } from "@/lib/sales-sheet/document-schema";
import { SalesSheetRenderer } from "../SalesSheetRenderer";
import { pxToMm, mmToViewportPx } from "./geometry";

// ---------------------------------------------------------------------------
// Dynamic import — Moveable is browser-only (uses DOM APIs at module init).
// ssr: false ensures it is never evaluated during server rendering / build.
// ---------------------------------------------------------------------------

const MoveableNoSSR = dynamic<MoveableProps>(() => import("react-moveable"), { ssr: false });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorCanvasProps {
  document: SalesSheetDocument;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Called when the selected element is dragged to a new position (in mm). */
  onMove?: (id: string, pos: { x: number; y: number }) => void;
  /** Called when the selected element is resized (in mm). */
  onResize?: (id: string, size: { w: number; h: number }) => void;
  /**
   * Canvas display zoom (CSS `transform: scale(zoom)` applied by the parent).
   * Required to convert Moveable viewport-px events back to mm.
   * Defaults to 1 (no zoom) when omitted.
   */
  zoom?: number;
  /**
   * Physical mm→px ratio (96 / 25.4 ≈ 3.7795 at 96 dpi).
   * Defaults to the 96 dpi value when omitted.
   */
  mmToPx?: number;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** z-index base for hit-box overlay — placed above all element z values. */
const HIT_BOX_Z_BASE = 1000;

/** Default mm-to-px ratio at 96 dpi. */
const DEFAULT_MM_TO_PX = 96 / 25.4;

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
 * EditorCanvas (plan-3 Task E + Task F)
 *
 * Renders the SalesSheetRenderer as a visual preview layer (A4 paper in mm),
 * then overlays a transparent click-target div per element.
 *
 * Task F additions:
 * - Attaches `<Moveable>` (dynamic, ssr:false) to the selected element's
 *   hit-box, enabling drag and resize.
 * - The Moveable target is captured directly from the click event (stored as
 *   state), avoiding any ref reads during render.
 * - `onDragEnd` / `onResizeEnd`: converts Moveable viewport-px values back to
 *   mm via the `geometry.ts` helpers and dispatches to the parent via
 *   `onMove` / `onResize` callbacks, which dispatch Task D reducers.
 * - `bounds` constrains drag/resize to the paper boundary.
 */
export function EditorCanvas({
  document,
  selectedId,
  onSelect,
  onMove,
  onResize,
  zoom = 1,
  mmToPx = DEFAULT_MM_TO_PX,
}: EditorCanvasProps) {
  const { page, elements } = document;

  // ── Moveable target ───────────────────────────────────────────────────────
  // Captured from the click event so we never read a ref during render.
  // Reset to null whenever selection is cleared.
  const [moveableTarget, setMoveableTarget] = useState<HTMLDivElement | null>(null);

  // ── Moveable bounds (paper boundary in viewport px) ──────────────────────
  const paperBounds = {
    left: 0,
    top: 0,
    right: mmToViewportPx(page.width, mmToPx, zoom),
    bottom: mmToViewportPx(page.height, mmToPx, zoom),
  };

  // ── Moveable event handlers ───────────────────────────────────────────────

  /** Visual feedback: move hit-box inline style while dragging. */
  function handleDrag({ target, left, top }: OnDrag) {
    const el = target as HTMLElement;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /**
   * Drag committed: convert viewport-px → mm, dispatch to reducer via onMove.
   * Resets inline styles so React's mm-based CSS takes over after re-render.
   */
  function handleDragEnd({ target, isDrag, lastEvent }: OnDragEnd) {
    const el = target as HTMLElement;
    if (isDrag && selectedId && onMove && lastEvent) {
      const x = pxToMm(lastEvent.left, mmToPx, zoom);
      const y = pxToMm(lastEvent.top, mmToPx, zoom);
      onMove(selectedId, { x, y });
    }
    // Reset inline styles; React re-render will apply mm values.
    el.style.left = "";
    el.style.top = "";
  }

  /** Visual feedback: resize hit-box inline style while resizing. */
  function handleResize({ target, width, height, drag }: OnResize) {
    const el = target as HTMLElement;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    // Resize from top/left handles also shifts the element origin.
    el.style.left = `${drag.left}px`;
    el.style.top = `${drag.top}px`;
  }

  /**
   * Resize committed: convert viewport-px → mm, dispatch to reducers.
   * Dispatches resize (size) always; dispatches move only when the element
   * origin actually shifted (top/left-handle resize). A bottom/right-handle
   * resize leaves the origin unchanged, so skipping the move dispatch avoids
   * a redundant setEditorState and a spurious dirty-mark.
   */
  function handleResizeEnd({ target, isDrag, lastEvent }: OnResizeEnd) {
    const el = target as HTMLElement;
    if (isDrag && selectedId && lastEvent) {
      const w = pxToMm(lastEvent.width, mmToPx, zoom);
      const h = pxToMm(lastEvent.height, mmToPx, zoom);
      if (onResize) {
        onResize(selectedId, { w, h });
      }
      // Only dispatch a move when the origin actually shifted (top/left-handle
      // resize). Compare converted mm values against the stored position using a
      // small epsilon to tolerate float conversion noise.
      if (onMove) {
        const x = pxToMm(lastEvent.drag.left, mmToPx, zoom);
        const y = pxToMm(lastEvent.drag.top, mmToPx, zoom);
        const currentEl = elements.find((e) => e.id === selectedId);
        const ORIGIN_EPSILON = 0.01; // mm
        if (
          !currentEl ||
          Math.abs(x - currentEl.x) > ORIGIN_EPSILON ||
          Math.abs(y - currentEl.y) > ORIGIN_EPSILON
        ) {
          onMove(selectedId, { x, y });
        }
      }
    }
    // Reset inline styles.
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.height = "";
  }

  // ── Render ────────────────────────────────────────────────────────────────

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
      onClick={() => {
        onSelect(null);
        setMoveableTarget(null);
      }}
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
              // Capture the DOM element now (in the event handler) so we can
              // pass it to Moveable without reading a ref during render.
              setMoveableTarget(e.currentTarget as HTMLDivElement);
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

      {/* ── Moveable: drag/resize handles for the selected element ───── */}
      {moveableTarget && (onMove || onResize) && (
        <MoveableNoSSR
          target={moveableTarget}
          draggable={true}
          resizable={true}
          throttleDrag={0}
          throttleResize={0}
          bounds={paperBounds}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
        />
      )}
    </div>
  );
}

export default EditorCanvas;
