"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { OnDrag, OnDragEnd, OnResize, OnResizeEnd, MoveableProps } from "react-moveable";
import type { SalesSheetDocument, SalesSheetElement } from "@/lib/sales-sheet/document-schema";
import { SalesSheetRenderer } from "../SalesSheetRenderer";
import { pxToMm } from "./geometry";

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
  /** Called when the selected element is resized (in mm). x/y は top/left ハンドルで
   *  原点が動いた時のみ入る(サイズと位置を1回の確定=1履歴として親がまとめて適用)。 */
  onResize?: (id: string, size: { w: number; h: number; x?: number; y?: number }) => void;
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

function hitBoxStyle(el: SalesSheetElement, isSelected: boolean, mmToPx: number): CSSProperties {
  // ⚠ px 単位で指定する(mm 文字列だと Moveable のリサイズ量計算が壊れ、ハンドルを掴んだ
  // 瞬間に要素が最小サイズへ潰れる実機バグの一因だった・2026-07-16 Playwright 実測)。
  return {
    position: "absolute",
    left: `${el.x * mmToPx}px`,
    top: `${el.y * mmToPx}px`,
    width: `${el.w * mmToPx}px`,
    height: `${el.h * mmToPx}px`,
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
 * - `onDragEnd` / `onResizeEnd`: converts Moveable CSS-px values back to mm
 *   (÷mmToPx のみ・zoom では割らない) and dispatches to the parent via
 *   `onMove` / `onResize` callbacks, which dispatch Task D reducers.
 * - 用紙内制約は Moveable bounds でなく確定時の reducer クランプで担保。
 */
export function EditorCanvas({
  document,
  selectedId,
  onSelect,
  onMove,
  onResize,
  mmToPx = DEFAULT_MM_TO_PX,
}: EditorCanvasProps) {
  const { page, elements } = document;

  // ── Moveable target ───────────────────────────────────────────────────────
  // The selected element's hit-box DOM node, captured by a callback ref on
  // whichever hit-box is currently selected. Deriving the target from the
  // selection (instead of from click events) keeps programmatic selection
  // working too — 「写真を追加」/「バッジを追加」 auto-select the new element.
  // Click-time capture alone would leave the handles attached to the
  // previously clicked node (dragging them would move the NEW element using
  // the OLD element's coordinates) and give a never-clicked element no
  // handles at all (@codex PR#252).
  // After deselection the last node may linger here; the render gate below
  // requires a live selectedId, so a stale node is never handed to Moveable.
  const [moveableTarget, setMoveableTarget] = useState<HTMLDivElement | null>(null);

  // ── ⚠ Moveable の bounds は使わない ────────────────────────────────────────
  // bounds は client(画面)座標で解釈され、画面中央に置かれた用紙では「リサイズハンドルを
  // 掴んだ瞬間に範囲外と判定→要素が最小サイズへ潰れる」実機バグを起こした(2026-07-16
  // ユーザー報告・position:"css" 指定でも実ブラウザで再現=Playwright で実測)。
  // 用紙内への制約はドラッグ中の視覚制限でなく、確定時に reducer(moveElement/resizeElement)
  // が mm 値でクランプして担保する(ドラッグ中に一瞬はみ出ても離した時点で用紙内へ収まる)。

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
      // Moveable のイベント値は CSS px(scale 前の空間)。zoom で割ると 10mm が 13.3mm に
      // 化ける(実測で確認)ため、mmToPx のみで割る。
      const x = pxToMm(lastEvent.left, mmToPx, 1);
      const y = pxToMm(lastEvent.top, mmToPx, 1);
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
   * Resize committed: convert viewport-px → mm, dispatch ONCE via onResize.
   * 原点が動いた(top/left ハンドル)場合は x/y も同じコールに含める=1回の確定が
   * 1回の state 更新(=「元に戻す」1回で戻る)になる。bottom/right ハンドルでは
   * x/y を含めず、位置の冗長な更新を避ける。
   */
  function handleResizeEnd({ target, isDrag, lastEvent }: OnResizeEnd) {
    const el = target as HTMLElement;
    if (isDrag && selectedId && lastEvent && onResize) {
      // CSS px → mm(zoom で割らない・onDragEnd と同じ理由)。
      const w = pxToMm(lastEvent.width, mmToPx, 1);
      const h = pxToMm(lastEvent.height, mmToPx, 1);
      const x = pxToMm(lastEvent.drag.left, mmToPx, 1);
      const y = pxToMm(lastEvent.drag.top, mmToPx, 1);
      const currentEl = elements.find((e) => e.id === selectedId);
      const ORIGIN_EPSILON = 0.01; // mm
      const originShifted =
        !currentEl ||
        Math.abs(x - currentEl.x) > ORIGIN_EPSILON ||
        Math.abs(y - currentEl.y) > ORIGIN_EPSILON;
      onResize(selectedId, originShifted ? { w, h, x, y } : { w, h });
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
            ref={(node) => {
              // Callback ref keeps moveableTarget in sync with the selection
              // (React bails out on same-node sets, so no render cascade).
              if (isSelected && node !== null) setMoveableTarget(node);
            }}
            style={hitBoxStyle(el, isSelected, mmToPx)}
            onClick={(e) => {
              e.stopPropagation();
              // Selection is the single source of truth — the effect above
              // resolves the Moveable target from selectedId after commit.
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
      {/* moveableTarget lags selection by one commit (effect-synced), so gate
          on selectedId too: when selection clears (e.g. the selected element
          is deleted from the panel), the handles disappear immediately even
          before the effect nulls the stale target. */}
      {selectedId !== null && moveableTarget && (onMove || onResize) && (
        <MoveableNoSSR
          target={moveableTarget}
          draggable={true}
          resizable={true}
          throttleDrag={0}
          throttleResize={0}
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
