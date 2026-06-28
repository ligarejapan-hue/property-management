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
  editText,
  deleteElement,
} from "@/lib/sales-sheet/editor-document";
import { EditorCanvas } from "./EditorCanvas";
import { ElementPanel } from "./ElementPanel";
import type { ElementPanelChange } from "./ElementPanel";

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
 * SalesSheetEditor — "use client" shell (plan-3 Task E + Task F + Task G)
 *
 * Holds EditorState (document + selectedId + dirty) via useState.
 * Renders the EditorCanvas in a scrollable, scale-transformed stage.
 *
 * Task F: wires drag/resize callbacks → moveElement / resizeElement /
 *   bringToFront / sendToBack reducers.
 *
 * Task G: mounts ElementPanel in the right panel — geometry (x/y/w/h in mm),
 *   z-order, delete, and text editing (content / font / size / color).
 *   All panel changes flow through handleElementPanelChange → Task-D reducers.
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

  /** Dispatches the appropriate Task-D reducer for every ElementPanel change. */
  function handleElementPanelChange(change: ElementPanelChange): void {
    setEditorState((prev) => {
      const id = prev.selectedId;
      if (!id) return prev;
      switch (change.type) {
        case "move":
          return moveElement(prev, id, { x: change.x, y: change.y });
        case "resize":
          return resizeElement(prev, id, { w: change.w, h: change.h });
        case "bringToFront":
          return bringToFront(prev, id);
        case "sendToBack":
          return sendToBack(prev, id);
        case "delete":
          return deleteElement(prev, id);
        case "editText":
          return editText(prev, id, change.patch);
      }
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const { page } = editorState.document;

  // Paper pixel dimensions at zoom
  const scaledW = page.width * MM_TO_PX * DEFAULT_ZOOM;
  const scaledH = page.height * MM_TO_PX * DEFAULT_ZOOM;

  /** Selected element object (null when nothing is selected). */
  const selectedElement =
    editorState.selectedId != null
      ? (editorState.document.elements.find((e) => e.id === editorState.selectedId) ?? null)
      : null;

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

        {/* Properties panel — Task G: ElementPanel (geometry + text editor) */}
        <div
          data-properties-panel
          className="w-64 shrink-0 border-l border-neutral-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 overflow-y-auto"
          aria-label="properties panel"
        >
          <ElementPanel
            element={selectedElement}
            onChange={handleElementPanelChange}
          />
        </div>
      </div>
    </div>
  );
}

export default SalesSheetEditor;
