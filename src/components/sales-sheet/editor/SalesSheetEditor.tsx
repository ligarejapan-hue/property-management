"use client";

import { useState } from "react";
import type { SalesSheetDocument } from "@/lib/sales-sheet/document-schema";
import type { EditorState } from "@/lib/sales-sheet/editor-document";
import {
  selectElement,
  moveElement,
  resizeElement,
  bringToFront,
  sendToBack,
} from "@/lib/sales-sheet/editor-document";
import { EditorCanvas } from "./EditorCanvas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SalesSheetEditorInitial {
  /** 初期ドキュメント（スキーマ検証済み） */
  document: SalesSheetDocument;
  /** DB 上のシート ID */
  sheetId: string;
  /** 紐付く物件 ID */
  propertyId: string;
  /** 最終保存日時（ISO 文字列） */
  updatedAt: string;
}

export interface SalesSheetEditorProps {
  initial: SalesSheetEditorInitial;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default canvas zoom (0.75 = 75%).
 * Task G will add zoom-in/out controls and convert this to useState.
 */
const DEFAULT_ZOOM = 0.75;

/** Millimetres to pixels at 96 dpi (96 / 25.4). */
const MM_TO_PX = 96 / 25.4;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * SalesSheetEditor — "use client" shell (plan-3 Task E + Task F)
 *
 * Holds EditorState (document + selectedId + dirty) via useState.
 * Renders the EditorCanvas in a scrollable, scale-transformed stage.
 *
 * Task F additions:
 * - Wires drag/resize callbacks → pure Task D reducers (moveElement /
 *   resizeElement / bringToFront / sendToBack).
 * - Renders z-order buttons (前面 / 背面) in the properties panel when an
 *   element is selected.
 */
export function SalesSheetEditor({ initial }: SalesSheetEditorProps) {
  const [editorState, setEditorState] = useState<EditorState>({
    document: initial.document,
    selectedId: null,
    dirty: false,
  });

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleSelect(id: string | null): void {
    setEditorState((prev) => selectElement(prev, id));
  }

  /** Dispatches moveElement reducer — called by EditorCanvas onDragEnd. */
  function handleMove(id: string, pos: { x: number; y: number }): void {
    setEditorState((prev) => moveElement(prev, id, pos));
  }

  /** Dispatches resizeElement reducer — called by EditorCanvas onResizeEnd. */
  function handleResize(id: string, size: { w: number; h: number }): void {
    setEditorState((prev) => resizeElement(prev, id, size));
  }

  /** Raises the selected element above all others. */
  function handleBringToFront(): void {
    setEditorState((prev) => (prev.selectedId ? bringToFront(prev, prev.selectedId) : prev));
  }

  /** Lowers the selected element below all others. */
  function handleSendToBack(): void {
    setEditorState((prev) => (prev.selectedId ? sendToBack(prev, prev.selectedId) : prev));
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const { page } = editorState.document;

  // Paper pixel dimensions at zoom
  const scaledW = page.width * MM_TO_PX * DEFAULT_ZOOM;
  const scaledH = page.height * MM_TO_PX * DEFAULT_ZOOM;

  const hasSelection = editorState.selectedId !== null;

  return (
    <div className="flex flex-col h-full bg-neutral-200 dark:bg-zinc-900">
      {/* ── Toolbar placeholder — Task G/H ───────────────────────────── */}
      <div data-toolbar-placeholder />

      {/* ── Main split ───────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Canvas stage (scrollable, paper scaled to DEFAULT_ZOOM) */}
        <div className="flex-1 overflow-auto">
          <div
            className="flex items-start justify-center p-8"
            style={{ minWidth: scaledW + 64, minHeight: scaledH + 64 }}
          >
            {/*
             * Scale wrapper: keeps layout footprint equal to the scaled paper
             * while transform:scale renders the full-mm canvas at zoom ratio.
             */}
            <div
              data-canvas-stage
              style={{
                width: scaledW,
                height: scaledH,
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transformOrigin: "top left",
                  transform: `scale(${DEFAULT_ZOOM})`,
                }}
              >
                <EditorCanvas
                  document={editorState.document}
                  selectedId={editorState.selectedId}
                  onSelect={handleSelect}
                  onMove={handleMove}
                  onResize={handleResize}
                  zoom={DEFAULT_ZOOM}
                  mmToPx={MM_TO_PX}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Properties panel — Task F z-order controls */}
        <div
          data-properties-panel
          className="w-64 shrink-0 border-l border-neutral-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 flex flex-col"
          aria-label="properties panel"
        >
          {hasSelection && (
            <div className="p-3 border-b border-neutral-200 dark:border-zinc-700">
              <p className="text-xs font-medium text-neutral-500 dark:text-zinc-400 mb-2">
                重ね順
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleBringToFront}
                  className="flex-1 rounded border border-neutral-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-neutral-700 dark:text-zinc-200 hover:bg-neutral-50 dark:hover:bg-zinc-600 transition-colors"
                  aria-label="前面に移動"
                >
                  前面
                </button>
                <button
                  type="button"
                  onClick={handleSendToBack}
                  className="flex-1 rounded border border-neutral-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-neutral-700 dark:text-zinc-200 hover:bg-neutral-50 dark:hover:bg-zinc-600 transition-colors"
                  aria-label="背面に移動"
                >
                  背面
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SalesSheetEditor;
