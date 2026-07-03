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
import type {
  EditTextPatch,
  EditImagePatch,
  EditBadgePatch,
  EditQrPatch,
  EditThemePatch,
} from "@/lib/sales-sheet/editor-document";
import type {
  SalesSheetElement,
  TextElement,
  ImageElement,
  BadgeElement,
  QrElement,
  SalesSheetTheme,
} from "@/lib/sales-sheet/document-schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ElementPanelChange =
  | { type: "move"; x: number; y: number }
  | { type: "resize"; w: number; h: number }
  | { type: "bringToFront" }
  | { type: "sendToBack" }
  | { type: "delete" }
  | { type: "editText"; patch: EditTextPatch }
  | { type: "editImage"; patch: EditImagePatch }
  | { type: "editBadge"; patch: EditBadgePatch }
  | { type: "editQr"; patch: EditQrPatch };

export interface ElementPanelProps {
  /** The currently selected element, or null when nothing is selected. */
  element: SalesSheetElement | null;
  onChange: (change: ElementPanelChange) => void;
  /** 文書テーマ。要素未選択時にテーマ編集 section を表示する（計画⑧）。 */
  theme: SalesSheetTheme;
  onThemeChange: (patch: EditThemePatch) => void;
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

/** 焦点位置プリセット（3×3）。cover トリミング時に写真のどこを見せるか。 */
export const FOCAL_PRESETS = [
  { x: 0, y: 0, label: "左上" },
  { x: 50, y: 0, label: "上" },
  { x: 100, y: 0, label: "右上" },
  { x: 0, y: 50, label: "左" },
  { x: 50, y: 50, label: "中央" },
  { x: 100, y: 50, label: "右" },
  { x: 0, y: 100, label: "左下" },
  { x: 50, y: 100, label: "下" },
  { x: 100, y: 100, label: "右下" },
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

/**
 * CSS 色を <input type="color"> が表現できる #rrggbb へ正規化する。
 * hex 系（#rgb / #rgba / #rrggbb / #rrggbbaa）は #rrggbb に展開/切詰め、
 * それ以外（named color / rgb() 等、isCssColor が許容する形式）は null。
 * null の場合はテキスト入力へフォールバックする — type=color に非 hex を
 * 渡すとブラウザが #000000 へ黙って化かし、表示も書き戻しも誤った色になる
 * ため（@codex PR#252）。
 */
export function hexColorInputValue(color: string): string | null {
  const v = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)) return v.slice(0, 7);
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return null;
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

const colorInputCls =
  "h-8 w-full cursor-pointer rounded border border-neutral-300 dark:border-zinc-600 " +
  "bg-white dark:bg-zinc-700 p-0.5";

// ---------------------------------------------------------------------------
// ColorField — 色入力（#rrggbb 表現可能なら type=color、それ以外は type=text）
// ---------------------------------------------------------------------------

/**
 * <input type="color"> は #rrggbb しか表現できないため、hex 系は正規化して
 * ピッカーで、それ以外の正当な CSS 色（named / rgb() 等）は値を化かさない
 * text 入力で編集する（@codex PR#252）。text 側は controlled にすると
 * isCssColor を通らない打ちかけの値で入力が固まるため、非制御
 * （defaultValue）にして有効値になった時だけ emit する。
 */
function ColorField({
  label,
  ariaLabel,
  value,
  onSafeChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  onSafeChange: (color: string) => void;
}) {
  const hex = hexColorInputValue(value);
  function handle(e: React.ChangeEvent<HTMLInputElement>): void {
    if (!isCssColor(e.target.value)) return;
    onSafeChange(e.target.value);
  }
  return (
    <label className="flex flex-col gap-0.5">
      <span className={labelSpanCls}>{label}</span>
      {hex !== null ? (
        <input
          type="color"
          aria-label={ariaLabel}
          value={hex}
          onChange={handle}
          className={colorInputCls}
        />
      ) : (
        <input
          type="text"
          aria-label={ariaLabel}
          defaultValue={value}
          onChange={handle}
          className={inputCls}
        />
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ElementPanel({ element, onChange, theme, onThemeChange }: ElementPanelProps) {
  // ── Empty state: 文書テーマ（計画⑧） ─────────────────────────────────────
  // 要素を選択していないときは、図面全体の設定（フォント/基調色）を編集できる。
  if (!element) {
    return (
      <div
        data-element-panel-empty
        className="flex flex-col divide-y divide-neutral-200 dark:divide-zinc-700 text-xs"
      >
        <section className="p-3" data-theme-editor>
          <p className={sectionHeadCls}>図面全体（テーマ）</p>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>図面全体のフォント</span>
              <select
                aria-label="図面全体のフォント"
                value={theme.fontFamily}
                onChange={(e) => {
                  if (!isSafeFontFamily(e.target.value)) return;
                  onThemeChange({ fontFamily: e.target.value });
                }}
                className={inputCls}
              >
                {PANEL_FONT_OPTIONS.every((f) => f.value !== theme.fontFamily) && (
                  <option value={theme.fontFamily}>(現在の設定)</option>
                )}
                {PANEL_FONT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <ColorField
              label="基調色（新しいバッジの既定色）"
              ariaLabel="基調色"
              value={theme.accentColor}
              onSafeChange={(accentColor) => onThemeChange({ accentColor })}
            />
          </div>
        </section>
        <p className="p-4 text-xs text-neutral-400 dark:text-zinc-500">
          要素を選択すると個別の編集ができます
        </p>
      </div>
    );
  }

  // Capture a stable non-null reference so TypeScript preserves narrowing inside
  // returned closures (function-parameter narrowing doesn't propagate into
  // closures that escape the function — assigning to a const here fixes that).
  const el = element;

  // ── Narrow to TextElement when type === "text" ───────────────────────────
  const textEl: TextElement | null = el.type === "text" ? el : null;
  // ── Narrow to ImageElement when type === "image" ─────────────────────────
  const imageEl: ImageElement | null = el.type === "image" ? el : null;
  // ── Narrow to BadgeElement when type === "badge" ─────────────────────────
  const badgeEl: BadgeElement | null = el.type === "badge" ? el : null;
  // ── Narrow to QrElement when type === "qr" ───────────────────────────────
  const qrEl: QrElement | null = el.type === "qr" ? el : null;

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

  // ── Image-edit handlers ──────────────────────────────────────────────────
  function onFit(e: React.ChangeEvent<HTMLSelectElement>): void {
    const fit = e.target.value;
    if (fit === "cover" || fit === "contain") {
      onChange({ type: "editImage", patch: { fit } });
    }
  }

  function onRadiusMm(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = parseFloat(e.target.value);
    if (!isFinite(v) || v < 0) return;
    onChange({ type: "editImage", patch: { radiusMm: v } });
  }

  function onAlt(e: React.ChangeEvent<HTMLInputElement>): void {
    onChange({ type: "editImage", patch: { alt: e.target.value } });
  }

  // ── Badge-edit handlers ──────────────────────────────────────────────────
  function onBadgeLabel(e: React.ChangeEvent<HTMLInputElement>): void {
    onChange({ type: "editBadge", patch: { label: e.target.value } });
  }

  function onBadgeShape(e: React.ChangeEvent<HTMLSelectElement>): void {
    const shape = e.target.value;
    if (shape === "rounded" || shape === "pill" || shape === "ribbon") {
      onChange({ type: "editBadge", patch: { shape } });
    }
  }

  function onBadgeFontSize(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = parseFloat(e.target.value);
    if (!isFinite(v) || v <= 0) return;
    onChange({ type: "editBadge", patch: { fontSizePt: v } });
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
            <ColorField
              key={`text-color-${textEl.id}`}
              label="色"
              ariaLabel="文字色"
              value={textEl.style.color ?? "#000000"}
              onSafeChange={(color) => onChange({ type: "editText", patch: { color } })}
            />
          </div>
        </section>
      )}

      {/* ── Image editor (image elements only) ────────────────────────── */}
      {imageEl !== null && (
        <section className="p-3" data-image-editor>
          <p className={sectionHeadCls}>写真</p>
          <div className="flex flex-col gap-2">
            {/* Fit */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>表示方法</span>
              <select
                aria-label="写真の表示方法"
                value={imageEl.fit}
                onChange={onFit}
                className={inputCls}
              >
                <option value="cover">枠を埋める（トリミング）</option>
                <option value="contain">全体を表示（余白可）</option>
              </select>
            </label>
            {/* Focal point (3×3) */}
            <div className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>焦点（トリミング時に見せる位置）</span>
              <div className="grid grid-cols-3 gap-1" data-focal-grid>
                {FOCAL_PRESETS.map((f) => {
                  const active =
                    (imageEl.focalX ?? 50) === f.x && (imageEl.focalY ?? 50) === f.y;
                  return (
                    <button
                      key={`${f.x}-${f.y}`}
                      type="button"
                      aria-label={`焦点 ${f.label}`}
                      aria-pressed={active}
                      onClick={() =>
                        onChange({ type: "editImage", patch: { focalX: f.x, focalY: f.y } })
                      }
                      className={`flex h-7 items-center justify-center rounded border text-xs transition-colors ${
                        active
                          ? "border-blue-500 bg-blue-50 text-blue-600 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300"
                          : "border-neutral-300 bg-white text-neutral-400 hover:bg-neutral-50 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-600"
                      }`}
                    >
                      ●
                    </button>
                  );
                })}
              </div>
            </div>
            {/* Corner radius */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>角丸 (mm)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                aria-label="角丸 (mm)"
                value={imageEl.radiusMm ?? 0}
                onChange={onRadiusMm}
                className={inputCls}
              />
            </label>
            {/* Alt text */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>代替テキスト</span>
              <input
                type="text"
                aria-label="代替テキスト"
                value={imageEl.alt ?? ""}
                onChange={onAlt}
                className={inputCls}
              />
            </label>
          </div>
        </section>
      )}

      {/* ── Badge editor (badge elements only) ────────────────────────── */}
      {badgeEl !== null && (
        <section className="p-3" data-badge-editor>
          <p className={sectionHeadCls}>バッジ</p>
          <div className="flex flex-col gap-2">
            {/* Label */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>文言</span>
              <input
                type="text"
                aria-label="バッジの文言"
                value={badgeEl.label}
                onChange={onBadgeLabel}
                className={inputCls}
              />
            </label>
            {/* Shape */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>形</span>
              <select
                aria-label="バッジの形"
                value={badgeEl.shape}
                onChange={onBadgeShape}
                className={inputCls}
              >
                <option value="rounded">角丸</option>
                <option value="pill">ピル（丸端）</option>
                <option value="ribbon">リボン</option>
              </select>
            </label>
            {/* Background color */}
            <ColorField
              key={`badge-bg-${badgeEl.id}`}
              label="背景色"
              ariaLabel="バッジ背景色"
              value={badgeEl.bg}
              onSafeChange={(bg) => onChange({ type: "editBadge", patch: { bg } })}
            />
            {/* Foreground color */}
            <ColorField
              key={`badge-fg-${badgeEl.id}`}
              label="文字色"
              ariaLabel="バッジ文字色"
              value={badgeEl.fg}
              onSafeChange={(fg) => onChange({ type: "editBadge", patch: { fg } })}
            />
            {/* Font size */}
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>サイズ (pt)</span>
              <input
                type="number"
                step="0.5"
                min="1"
                aria-label="バッジ文字サイズ (pt)"
                value={badgeEl.fontSizePt ?? 10}
                onChange={onBadgeFontSize}
                className={inputCls}
              />
            </label>
          </div>
        </section>
      )}

      {/* ── QR editor (qr elements only) ───────────────────────────────── */}
      {qrEl !== null && (
        <section className="p-3" data-qr-editor>
          <p className={sectionHeadCls}>QRコード</p>
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-0.5">
              <span className={labelSpanCls}>QRの中身（URL等・半角）</span>
              {/* 非制御: controlled + ガードだと打ちかけの値で入力が固まるため、
                  確定（blur）時に有効な値だけ反映して QR を再生成する。 */}
              <input
                key={qrEl.id}
                type="text"
                aria-label="QRの中身"
                defaultValue={qrEl.content ?? ""}
                onBlur={(e) => {
                  // 値が変わっていない blur（コピーのためのクリック等）では
                  // editQr を発行しない＝不要な dirty 化を避ける。
                  const next = e.target.value.trim();
                  if (next === (qrEl.content ?? "")) return;
                  onChange({ type: "editQr", patch: { content: next } });
                }}
                className={inputCls}
              />
            </label>
            <p className="text-[10px] text-neutral-400 dark:text-zinc-500">
              半角の URL 等のみ。空欄・全角文字は反映されません（欄外クリックで確定）
            </p>
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
