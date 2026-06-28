"use client";

/**
 * ElementPanel.tsx — 右パネル（geometry + 文字編集）(plan-3 Task G)
 *
 * Shows editors for the selected SalesSheetElement:
 *   - All elements: x/y/w/h (mm), z-order (front/back), delete.
 *   - Text elements only: content, font-family, font-size (pt), color.
 *
 * All changes are emitted via `onChange(ElementPanelChange)`.
 * The parent (SalesSheetEditor) dispatches to the appropriate Task-D reducer.
 *
 * Color inputs are guarded by `isCssColor` before calling onChange.
 * Font options are a static allow-list verified against `isSafeFontFamily`.
 */

import { isCssColor, isSafeFontFamily } from "@/lib/sales-sheet/css-safety";
import type { EditTextPatch } from "@/lib/sales-sheet/editor-document";
import type { SalesSheetElement, TextElement } from "@/lib/sales-sheet/document-schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ElementPanelChange =
  | { type: "move"; x: number; y: number }
  | { type: "resize"; w: number; h: number }
  | { type: "bringToFront" }
  | { type: "sendToBack" }
  | { type: "delete" }
  | { type: "editText"; patch: EditTextPatch };

export interface ElementPanelProps {
  /** The currently selected element, or null when nothing is selected. */
  element: SalesSheetElement | null;
  onChange: (change: ElementPanelChange) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Font-family options for the <select>.
 * Every `value` passes `isSafeFontFamily` (tested in element-panel.test.tsx).
 */
export const PANEL_FONT_OPTIONS = [
  { label: "Yu Gothic UI (ゴシック)", value: '"Yu Gothic UI","Meiryo",sans-serif' },
  {
    label: "Hiragino (ゴシック)",
    value: '"Hiragino Kaku Gothic ProN","Hiragino Sans",sans-serif',
  },
  { label: "BIZ UD ゴシック", value: '"BIZ UDGothic",sans-serif' },
  { label: "BIZ UD 明朝", value: '"BIZ UDMincho",serif' },
  { label: "サンセリフ", value: "sans-serif" },
  { label: "セリフ", value: "serif" },
  { label: "等幅", value: "monospace" },
] as const;

// ---------------------------------------------------------------------------
// Pure helpers (exported for env=node unit tests)
// ---------------------------------------------------------------------------

/**
 * Build an ElementPanelChange for a geometry-field value change.
 * Returns null when rawValue is not a finite number.
 *
 * Exported so tests can verify patch shape without needing jsdom.
 */
export function buildGeometryChange(
  field: "x" | "y" | "w" | "h",
  rawValue: string,
  element: SalesSheetElement,
): ElementPanelChange | null {
  const v = parseFloat(rawValue);
  if (!isFinite(v)) return null;
  if (field === "x") return { type: "move", x: v, y: element.y };
  if (field === "y") return { type: "move", x: element.x, y: v };
  if (field === "w") return { type: "resize", w: v, h: element.h };
  return { type: "resize", w: element.w, h: v };
}

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

const inputCls =
  "w-full rounded border border-neutral-300 dark:border-zinc-600 " +
  "bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-neutral-800 dark:text-zinc-100 " +
  "focus:outline-none focus:ring-1 focus:ring-blue-500";

const labelSpanCls = "text-[10px] text-neutral-400 dark:text-zinc-500";

const sectionHeadCls = "text-xs font-medium text-neutral-500 dark:text-zinc-400 mb-2";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ElementPanel({ element, onChange }: ElementPanelProps) {
  // ── Empty state ─────────────────────────────────────────────────────────
  if (!element) {
    return (
      <div
        data-element-panel-empty
        className="p-4 text-xs text-neutral-400 dark:text-zinc-500"
      >
        要素を選択してください
      </div>
    );
  }

  // Capture a stable non-null reference so TypeScript preserves narrowing inside
  // returned closures (function-parameter narrowing doesn't propagate into
  // closures that escape the function — assigning to a const here fixes that).
  const el = element;

  // ── Narrow to TextElement when type === "text" ───────────────────────────
  const textEl: TextElement | null = el.type === "text" ? el : null;

  // ── Geometry handlers ────────────────────────────────────────────────────
  function onGeomChange(field: "x" | "y" | "w" | "h") {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const change = buildGeometryChange(field, e.target.value, el);
      if (change) onChange(change);
    };
  }

  // ── Text-edit handlers ───────────────────────────────────────────────────
  function onContent(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    onChange({ type: "editText", patch: { content: e.target.value } });
  }

  function onFontFamily(e: React.ChangeEvent<HTMLSelectElement>): void {
    if (!isSafeFontFamily(e.target.value)) return;
    onChange({ type: "editText", patch: { fontFamily: e.target.value } });
  }

  function onFontSize(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = parseFloat(e.target.value);
    if (!isFinite(v) || v <= 0) return;
    onChange({ type: "editText", patch: { fontSizePt: v } });
  }

  function onColor(e: React.ChangeEvent<HTMLInputElement>): void {
    if (!isCssColor(e.target.value)) return;
    onChange({ type: "editText", patch: { color: e.target.value } });
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      data-element-panel
      className="flex flex-col divide-y divide-neutral-200 dark:divide-zinc-700 text-xs"
    >
      {/* ── Geometry ──────────────────────────────────────────────────── */}
      <section className="p-3">
        <p className={sectionHeadCls}>位置・サイズ (mm)</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className={labelSpanCls}>X</span>
            <input
              type="number"
              step="0.5"
              aria-label="X位置 (mm)"
              value={el.x}
              onChange={onGeomChange("x")}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelSpanCls}>Y</span>
            <input
              type="number"
              step="0.5"
              aria-label="Y位置 (mm)"
              value={el.y}
              onChange={onGeomChange("y")}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelSpanCls}>幅</span>
            <input
              type="number"
              step="0.5"
              min="5"
              aria-label="幅 (mm)"
              value={el.w}
              onChange={onGeomChange("w")}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelSpanCls}>高さ</span>
            <input
              type="number"
              step="0.5"
              min="5"
              aria-label="高さ (mm)"
              value={el.h}
              onChange={onGeomChange("h")}
              className={inputCls}
            />
          </label>
        </div>
      </section>

      {/* ── Z-order ───────────────────────────────────────────────────── */}
      <section className="p-3">
        <p className={sectionHeadCls}>重ね順</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange({ type: "bringToFront" })}
            className="flex-1 rounded border border-neutral-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-neutral-700 dark:text-zinc-200 hover:bg-neutral-50 dark:hover:bg-zinc-600 transition-colors"
            aria-label="前面に移動"
          >
            前面
          </button>
          <button
            type="button"
            onClick={() => onChange({ type: "sendToBack" })}
            className="flex-1 rounded border border-neutral-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-neutral-700 dark:text-zinc-200 hover:bg-neutral-50 dark:hover:bg-zinc-600 transition-colors"
            aria-label="背面に移動"
          >
            背面
          </button>
        </div>
      </section>

      {/* ── Text editor (text elements only) ──────────────────────────── */}
      {textEl !== null && (
        <section className="p-3" data-text-editor>
          <p className={sectionHeadCls}>テキスト</p>
          <div className="flex flex-col gap-2">
            {/* Content */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>内容</span>
              <textarea
                aria-label="テキスト内容"
                rows={3}
                value={textEl.content}
                onChange={onContent}
                className={`${inputCls} resize-y`}
              />
            </label>
            {/* Font family */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>フォント</span>
              <select
                aria-label="フォント"
                value={textEl.style.fontFamily ?? ""}
                onChange={onFontFamily}
                className={inputCls}
              >
                <option value="">(デフォルト)</option>
                {PANEL_FONT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {/* Font size */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>サイズ (pt)</span>
              <input
                type="number"
                step="0.5"
                min="1"
                aria-label="フォントサイズ (pt)"
                value={textEl.style.fontSizePt ?? 12}
                onChange={onFontSize}
                className={inputCls}
              />
            </label>
            {/* Color */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>色</span>
              <input
                type="color"
                aria-label="文字色"
                value={textEl.style.color ?? "#000000"}
                onChange={onColor}
                className="h-8 w-full cursor-pointer rounded border border-neutral-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 p-0.5"
              />
            </label>
          </div>
        </section>
      )}

      {/* ── Delete ────────────────────────────────────────────────────── */}
      <section className="p-3">
        <button
          type="button"
          onClick={() => onChange({ type: "delete" })}
          className="w-full rounded border border-red-300 dark:border-red-700 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          aria-label="要素を削除"
        >
          削除
        </button>
      </section>
    </div>
  );
}
