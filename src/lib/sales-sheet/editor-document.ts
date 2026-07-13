/**
 * editor-document.ts
 *
 * Pure, immutable editor-state reducers for the sales-sheet canvas editor.
 *
 * EditorState = { document, selectedId, dirty }
 *
 * All reducers return a NEW EditorState; input is never mutated.
 * After every document-mutating op, the resulting document is guaranteed to
 * remain parseable by `parseSalesSheetDocument` (verified in unit tests).
 *
 * Schema note: the text element stores fontSizePt / color / fontFamily inside
 * a `style` sub-object (not directly on the element). The flat `EditTextPatch`
 * API maps these fields into `style` internally.
 */

import { isCssColor, isSafeFontFamily, isSafeImageSrc } from "./css-safety";
import { generateQrDataUrl } from "./qr-code";
import {
  computeSpecSheetLayout,
  DEFAULT_FOOTER_H,
  MAIN_BOTTOM_MARGIN_MM,
  SALES_POINTS_H_MM,
  PHOTO_GAP_MM,
  packPhotoCells,
} from "./layout-engine";
import {
  buildFooterTransactionElements,
  readFooterData,
  footerDataEqual,
  type FooterBandData,
} from "./footer-band";
import type {
  SalesSheetDocument,
  SalesSheetElement,
  TextElement,
  ImageElement,
  BadgeElement,
  QrElement,
  TableElement,
} from "./document-schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditorState {
  readonly document: SalesSheetDocument;
  readonly selectedId: string | null;
  readonly dirty: boolean;
}

/** Flat patch for text-element fields (fontSizePt/color/fontFamily are mapped
 *  into the `style` sub-object by editText). */
export interface EditTextPatch {
  readonly content?: string;
  /** Maps to style.fontSizePt. Must be > 0 (ignored otherwise). */
  readonly fontSizePt?: number;
  /** Maps to style.color. Validated via isCssColor (ignored if invalid). */
  readonly color?: string;
  /** Maps to style.fontFamily. Validated via isSafeFontFamily (ignored if invalid). */
  readonly fontFamily?: string;
}

/** Flat patch for image-element fields (editImage). */
export interface EditImagePatch {
  /** object-fit。cover=枠を埋めてトリミング / contain=全体表示（余白可）。 */
  readonly fit?: "cover" | "contain";
  /** 焦点位置(%)。cover 時に見せる位置。0-100 にクランプ。 */
  readonly focalX?: number;
  readonly focalY?: number;
  /** 角丸(mm)。負値は無視。 */
  readonly radiusMm?: number;
  /** 代替テキスト。 */
  readonly alt?: string;
}

/** Flat patch for badge-element fields (editBadge). */
export interface EditBadgePatch {
  /** バッジの文言。 */
  readonly label?: string;
  /** 形状。rounded=角丸 / pill=ピル / ribbon=リボン。 */
  readonly shape?: "rounded" | "pill" | "ribbon";
  /** 背景色。isCssColor で検証（不正は無視）。 */
  readonly bg?: string;
  /** 文字色。isCssColor で検証（不正は無視）。 */
  readonly fg?: string;
  /** フォントサイズ(pt)。0 以下は無視。 */
  readonly fontSizePt?: number;
}

/** Flat patch for qr-element fields (editQr). */
export interface EditQrPatch {
  /** QR の中身（URL 等・半角）。変更すると dataURL を再生成する。
   *  空・非 ASCII・容量超過など生成不能な値は無視（no-op）。 */
  readonly content?: string;
}

/** 文書テーマの patch (editTheme)。 */
export interface EditThemePatch {
  /** ページ全体のフォント。isSafeFontFamily で検証（不正は無視）。 */
  readonly fontFamily?: string;
  /** 基調色。isCssColor で検証（不正は無視）。新規バッジの既定色等に使われる。 */
  readonly accentColor?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum element dimension in mm — enforced by resizeElement. */
export const MIN_ELEMENT_SIZE_MM = 5;

/** ギャラリーから追加する画像の既定サイズ(mm)。 */
const DEFAULT_IMAGE_W_MM = 90;
const DEFAULT_IMAGE_H_MM = 60;

/** 追加するバッジの既定サイズ(mm)と既定ラベル。 */
const DEFAULT_BADGE_W_MM = 40;
const DEFAULT_BADGE_H_MM = 12;
const DEFAULT_BADGE_LABEL = "新着";
/** 追加するバッジの既定文字サイズ(pt)。未設定だとレンダラがページ既定を継承し
 *  パネル表示とズレるため、作成時に明示的に永続化する（WYSIWYG）。 */
const DEFAULT_BADGE_FONT_SIZE_PT = 10;

/** 追加する QR の既定サイズ(mm・正方形)。 */
const DEFAULT_QR_SIZE_MM = 30;

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/**
 * Select an element by id, or deselect with null.
 * Does NOT set dirty — selection is UI state, not a document change.
 */
export function selectElement(state: EditorState, id: string | null): EditorState {
  return { ...state, selectedId: id };
}

/**
 * Move element to (x, y) clamped to [0 .. page.width − el.w] × [0 .. page.height − el.h].
 * Sets dirty=true. No-op if id is not found.
 */
export function moveElement(
  state: EditorState,
  id: string,
  pos: { x: number; y: number },
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  const { page } = document;
  const x = clamp(pos.x, 0, Math.max(0, page.width - el.w));
  const y = clamp(pos.y, 0, Math.max(0, page.height - el.h));
  return replaceElement(state, idx, applyGeom(el, { x, y }));
}

/**
 * Resize element to (w, h), each clamped to MIN_ELEMENT_SIZE_MM.
 * Sets dirty=true. No-op if id is not found.
 */
export function resizeElement(
  state: EditorState,
  id: string,
  size: { w: number; h: number },
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  const w = Math.max(MIN_ELEMENT_SIZE_MM, size.w);
  const h = Math.max(MIN_ELEMENT_SIZE_MM, size.h);
  return replaceElement(state, idx, applyGeom(el, { w, h }));
}

/**
 * Raise element z above the current maximum.
 * Sets dirty=true. No-op if id is not found.
 */
export function bringToFront(state: EditorState, id: string): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const maxZ = Math.max(...document.elements.map((e) => e.z));
  return replaceElement(state, idx, applyGeom(document.elements[idx], { z: maxZ + 1 }));
}

/**
 * Lower element z below the current minimum.
 * Sets dirty=true. No-op if id is not found.
 */
export function sendToBack(state: EditorState, id: string): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const minZ = Math.min(...document.elements.map((e) => e.z));
  const targetZ = minZ - 1;
  // z must stay non-negative: the renderer uses z directly as a CSS z-index, and a
  // negative z paints behind the page's own white background (the element vanishes
  // in the editor and exported PDF/PNG). When going below 0 would be required,
  // renormalize — put the target at 0 and shift every other element up by the
  // deficit, preserving relative order.
  if (targetZ < 0) {
    const shift = -targetZ;
    const elements = document.elements.map((e, i) =>
      i === idx ? applyGeom(e, { z: 0 }) : applyGeom(e, { z: e.z + shift }),
    );
    return { ...state, dirty: true, document: { ...document, elements } };
  }
  return replaceElement(state, idx, applyGeom(document.elements[idx], { z: targetZ }));
}

/**
 * Set element z to an explicit integer value (non-integer input is truncated).
 * Clamped to >= 0 — a negative z renders behind the page background (see sendToBack).
 * Sets dirty=true. No-op if id is not found.
 */
export function setZ(state: EditorState, id: string, z: number): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  return replaceElement(state, idx, applyGeom(document.elements[idx], { z: Math.max(0, Math.trunc(z)) }));
}

/**
 * Remove element from the document.
 * If the deleted element was selected, selectedId becomes null.
 * Sets dirty=true. No-op if id is not found.
 */
export function deleteElement(state: EditorState, id: string): EditorState {
  const { document, selectedId } = state;
  if (!document.elements.some((e) => e.id === id)) return state;
  return {
    ...state,
    selectedId: selectedId === id ? null : selectedId,
    dirty: true,
    document: {
      ...document,
      elements: document.elements.filter((e) => e.id !== id),
    },
  };
}

/**
 * Apply a partial patch to a text element's content / style fields.
 * - Non-text elements: no-op (returns same state reference).
 * - Unknown id: no-op (returns same state reference).
 * - color / fontFamily: validated via css-safety; invalid values are silently ignored.
 * - fontSizePt: must be > 0; non-positive values are silently ignored.
 * Sets dirty=true on success.
 */
export function editText(
  state: EditorState,
  id: string,
  patch: EditTextPatch,
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "text") return state;

  const textEl = el as TextElement;
  const newStyle = { ...textEl.style };

  if (patch.fontSizePt !== undefined && patch.fontSizePt > 0) {
    newStyle.fontSizePt = patch.fontSizePt;
  }
  if (patch.color !== undefined && isCssColor(patch.color)) {
    newStyle.color = patch.color;
  }
  if (patch.fontFamily !== undefined && isSafeFontFamily(patch.fontFamily)) {
    newStyle.fontFamily = patch.fontFamily;
  }

  const newContent = patch.content !== undefined ? patch.content : textEl.content;
  const newEl: TextElement = { ...textEl, content: newContent, style: newStyle };

  return replaceElement(state, idx, newEl);
}

/**
 * ギャラリーで選んだ写真を新しい image 要素として document 末尾に追加する。
 * - src は保存境界と同じ isSafeImageSrc（/uploads/ か data: のみ）で検証。
 *   不正なら no-op（同一 state 参照）＝未認可 raw key を document に入れない。
 * - 既定サイズでページ中央に配置、z は既存最大+1（最前面）、自動選択して dirty=true。
 * - 実データの認可（この物件に属するか）は保存時 assertDocumentImagesAuthorized が担保。
 */
export function addImageElement(
  state: EditorState,
  params: { id: string; src: string; alt?: string },
): EditorState {
  if (!isSafeImageSrc(params.src)) return state;
  const { document } = state;
  const { page } = document;
  const w = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_IMAGE_W_MM, page.width - 10));
  const h = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_IMAGE_H_MM, page.height - 10));
  const z = document.elements.length
    ? Math.max(...document.elements.map((e) => e.z)) + 1
    : 1;
  const el: ImageElement = {
    id: params.id,
    type: "image",
    x: (page.width - w) / 2,
    y: (page.height - h) / 2,
    w,
    h,
    z,
    src: params.src,
    fit: "cover",
    ...(params.alt ? { alt: params.alt } : {}),
  };
  return {
    ...state,
    dirty: true,
    selectedId: params.id,
    document: { ...document, elements: [...document.elements, el] },
  };
}

/**
 * Apply a partial patch to an image element (fit / focal point / radius / alt).
 * - Non-image elements: no-op (same state reference).
 * - Unknown id: no-op (same state reference).
 * - focalX / focalY: clamped to 0-100.
 * - radiusMm: must be >= 0; negative values are ignored.
 * Sets dirty=true on success.
 */
export function editImage(
  state: EditorState,
  id: string,
  patch: EditImagePatch,
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "image") return state;

  const newEl: ImageElement = { ...el };
  if (patch.fit === "cover" || patch.fit === "contain") newEl.fit = patch.fit;
  if (patch.focalX !== undefined) newEl.focalX = clamp(patch.focalX, 0, 100);
  if (patch.focalY !== undefined) newEl.focalY = clamp(patch.focalY, 0, 100);
  if (patch.radiusMm !== undefined && patch.radiusMm >= 0) newEl.radiusMm = patch.radiusMm;
  if (patch.alt !== undefined) newEl.alt = patch.alt;

  return replaceElement(state, idx, newEl);
}

/**
 * オリジナルバッジを新しい badge 要素として document 末尾に追加する。
 * - 既定色はテーマ accent（背景）×白（文字）。テーマ色は schema の isCssColor
 *   検証済みのため、そのまま badge の bg に使って安全。
 * - 既定サイズでページ中央に配置、z は既存最大+1（最前面）、自動選択して dirty=true。
 */
export function addBadgeElement(
  state: EditorState,
  params: { id: string; label?: string },
): EditorState {
  const { document } = state;
  const { page } = document;
  const w = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_BADGE_W_MM, page.width - 10));
  const h = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_BADGE_H_MM, page.height - 10));
  const z = document.elements.length
    ? Math.max(...document.elements.map((e) => e.z)) + 1
    : 1;
  const el: BadgeElement = {
    id: params.id,
    type: "badge",
    x: (page.width - w) / 2,
    y: (page.height - h) / 2,
    w,
    h,
    z,
    label: params.label ?? DEFAULT_BADGE_LABEL,
    shape: "rounded",
    bg: document.theme.accentColor,
    fg: "#ffffff",
    fontSizePt: DEFAULT_BADGE_FONT_SIZE_PT,
  };
  return {
    ...state,
    dirty: true,
    selectedId: params.id,
    document: { ...document, elements: [...document.elements, el] },
  };
}

/**
 * Apply a partial patch to a badge element (label / shape / colors / font size).
 * - Non-badge elements: no-op (same state reference).
 * - Unknown id: no-op (same state reference).
 * - bg / fg: validated via isCssColor; invalid values are silently ignored.
 * - shape: only rounded / pill / ribbon are accepted.
 * - fontSizePt: must be > 0; non-positive values are silently ignored.
 * Sets dirty=true on success.
 */
export function editBadge(
  state: EditorState,
  id: string,
  patch: EditBadgePatch,
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "badge") return state;

  const newEl: BadgeElement = { ...el };
  if (patch.label !== undefined) newEl.label = patch.label;
  if (patch.shape === "rounded" || patch.shape === "pill" || patch.shape === "ribbon") {
    newEl.shape = patch.shape;
  }
  if (patch.bg !== undefined && isCssColor(patch.bg)) newEl.bg = patch.bg;
  if (patch.fg !== undefined && isCssColor(patch.fg)) newEl.fg = patch.fg;
  if (patch.fontSizePt !== undefined && patch.fontSizePt > 0) {
    newEl.fontSizePt = patch.fontSizePt;
  }

  return replaceElement(state, idx, newEl);
}

/**
 * QR コードを新しい qr 要素として document 末尾に追加する。
 * - content から dataURL をクライアント生成（qrcode-generator・決定的）。
 *   生成不能（空/非 ASCII/容量超過）なら no-op（同一 state 参照）。
 * - content も要素に保存し、後からパネルで再編集→再生成できるようにする。
 * - 既定 30×30mm でページ中央、z は既存最大+1、自動選択して dirty=true。
 */
export function addQrElement(
  state: EditorState,
  params: { id: string; content: string },
): EditorState {
  // trim して保存＝QR に実際にエンコードされる値（generateQrDataUrl 内も trim）
  // とパネル表示を一致させる。
  const content = params.content.trim();
  const dataUrl = generateQrDataUrl(content);
  if (dataUrl === null) return state;
  const { document } = state;
  const { page } = document;
  const w = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_QR_SIZE_MM, page.width - 10));
  const h = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_QR_SIZE_MM, page.height - 10));
  const z = document.elements.length
    ? Math.max(...document.elements.map((e) => e.z)) + 1
    : 1;
  const el: QrElement = {
    id: params.id,
    type: "qr",
    x: (page.width - w) / 2,
    y: (page.height - h) / 2,
    w,
    h,
    z,
    dataUrl,
    content,
  };
  return {
    ...state,
    dirty: true,
    selectedId: params.id,
    document: { ...document, elements: [...document.elements, el] },
  };
}

/**
 * QR 要素の中身（content）を変更し dataURL を再生成する。
 * - Non-qr elements / unknown id: no-op (same state reference).
 * - 生成不能な content（空/非 ASCII/容量超過）: no-op（元の QR を保持）。
 * Sets dirty=true on success.
 */
export function editQr(
  state: EditorState,
  id: string,
  patch: EditQrPatch,
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "qr") return state;
  if (patch.content === undefined) return state;

  const content = patch.content.trim();
  const dataUrl = generateQrDataUrl(content);
  if (dataUrl === null) return state;
  const newEl: QrElement = { ...el, content, dataUrl };
  return replaceElement(state, idx, newEl);
}

/**
 * 文書テーマ（ページ全体のフォント / 基調色）を更新する。
 * - fontFamily: isSafeFontFamily / accentColor: isCssColor で検証（不正は無視）。
 * - 要素と選択状態には触れない。Sets dirty=true.
 */
export function editTheme(state: EditorState, patch: EditThemePatch): EditorState {
  const { document } = state;
  const newTheme = { ...document.theme };
  if (patch.fontFamily !== undefined && isSafeFontFamily(patch.fontFamily)) {
    newTheme.fontFamily = patch.fontFamily;
  }
  if (patch.accentColor !== undefined && isCssColor(patch.accentColor)) {
    newTheme.accentColor = patch.accentColor;
  }
  return {
    ...state,
    dirty: true,
    document: { ...document, theme: newTheme },
  };
}

// ---------------------------------------------------------------------------
// 概要表の編集（計画⑧ 第2弾）
// 作成時にしか表へ入力できなかった制限（方式A）を解消する。
// ---------------------------------------------------------------------------

/** 行 patch (editTableRow)。undefined のフィールドは据え置き。 */
export interface EditTableRowPatch {
  readonly label?: string;
  readonly value?: string;
}

/**
 * 概要表の 1 行（label / value）を更新する。
 * - Non-table elements / unknown id / out-of-range index: no-op (same reference).
 * Sets dirty=true on success.
 */
export function editTableRow(
  state: EditorState,
  id: string,
  index: number,
  patch: EditTableRowPatch,
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "table") return state;
  if (!Number.isInteger(index) || index < 0 || index >= el.rows.length) return state;

  const rows = el.rows.slice();
  rows[index] = {
    label: patch.label !== undefined ? patch.label : rows[index].label,
    value: patch.value !== undefined ? patch.value : rows[index].value,
  };
  const newEl: TableElement = { ...el, rows };
  return replaceElement(state, idx, newEl);
}

/**
 * 概要表の末尾に空行を追加する。
 * - Non-table elements / unknown id: no-op (same reference).
 * Sets dirty=true on success.
 */
export function addTableRow(state: EditorState, id: string): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "table") return state;

  const newEl: TableElement = { ...el, rows: [...el.rows, { label: "", value: "" }] };
  return replaceElement(state, idx, newEl);
}

/**
 * 概要表の行を削除する（空の表になることも許容＝schema 上有効）。
 * - Non-table elements / unknown id / out-of-range index: no-op (same reference).
 * Sets dirty=true on success.
 */
export function removeTableRow(
  state: EditorState,
  id: string,
  index: number,
): EditorState {
  const { document } = state;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  if (el.type !== "table") return state;
  if (!Number.isInteger(index) || index < 0 || index >= el.rows.length) return state;

  const newEl: TableElement = { ...el, rows: el.rows.filter((_, i) => i !== index) };
  return replaceElement(state, idx, newEl);
}

// ---------------------------------------------------------------------------
// 会社帯の取引情報（物件別6項目）の一括編集
// ---------------------------------------------------------------------------

/**
 * 会社帯の物件別6項目(取引態様/広告/報酬/担当者/取引士/特記事項)をまとめて更新する。
 * - 帯外枠 footer-band の矩形を帯領域として、取引条件/担当テーブル(+担当区切り線)だけを
 *   buildFooterTransactionElements で再生成し、既存の取引系要素と差し替える。
 * - 会社ブロック・写真・他要素・footer-divider-terms は不変。
 * - footer-band が無い document(壊れた図面)では no-op(同一参照)。
 * - 現状の6値(readFooterData)と等価(footerDataEqual)なら no-op(同一参照)＝手動配置も保持。
 * - 要素順は footer-divider-terms の直後へ挿入して保つ。変更時 dirty=true。
 */
export function editFooterData(state: EditorState, data: FooterBandData): EditorState {
  const { document } = state;
  const band = document.elements.find((e) => e.id === "footer-band");
  if (!band) return state;
  if (footerDataEqual(readFooterData(document.elements), data)) return state;

  const footer = { x: band.x, y: band.y, w: band.w, h: band.h };
  const regenerated = buildFooterTransactionElements(footer, data);
  const TX_IDS = new Set(["footer-terms-table", "footer-divider-staff", "footer-staff-table"]);

  const elements: SalesSheetElement[] = [];
  let inserted = false;
  for (const el of document.elements) {
    if (TX_IDS.has(el.id)) continue;
    elements.push(el);
    if (el.id === "footer-divider-terms") {
      elements.push(...regenerated);
      inserted = true;
    }
  }
  if (!inserted) elements.push(...regenerated);

  return { ...state, dirty: true, document: { ...document, elements } };
}

// ---------------------------------------------------------------------------
// 自動レイアウト（計画⑥）
// ---------------------------------------------------------------------------

/** 写真ゾーン: テンプレの左カラム（タイトル/価格帯の下・概要表の左・会社帯の上）。 */
const PHOTO_ZONE_X_MM = 10;
const PHOTO_ZONE_Y_MM = 46;
const PHOTO_ZONE_MAX_W_MM = 130;
// 写真ゾーン下端を、エンジンが写真敷詰めを止める位置（photoPackBottom = mainBottom −
// salesPoints帯 − gap）に合わせる（@codex R1/R2）。会社帯だけでなく salesPoints 帯も避け、
// 作成/再バランス経路と同じ予約にする。page 下端からの余白＝帯高 + main下余白 + salesPoints高 + gap。
const PHOTO_ZONE_BOTTOM_MARGIN_MM =
  DEFAULT_FOOTER_H + MAIN_BOTTOM_MARGIN_MM + SALES_POINTS_H_MM + PHOTO_GAP_MM;

/**
 * すべての image 要素を写真ゾーンへ整列し直す（ワンボタン自動レイアウト）。
 * - 対象は image のみ。他要素（テキスト/表/バッジ等）は参照ごと不動。
 * - 配列順（＝追加順・テンプレは代表写真が先頭）にセルへ流し込む。先頭が左上。
 * - 幾何(x/y/w/h)のみ更新。src/fit/焦点/z などは保存。
 * - 決定的: 同じ document からは常に同じ配置。既に整列済みなら no-op（同一参照）。
 * - 画像が無ければ no-op。変更があれば dirty=true。
 */
export function autoArrangePhotos(state: EditorState): EditorState {
  const { document } = state;
  const { page } = document;
  const targets: number[] = [];
  document.elements.forEach((e, i) => {
    if (e.type === "image") targets.push(i);
  });
  if (targets.length === 0) return state;

  const zoneX = PHOTO_ZONE_X_MM;
  const zoneY = PHOTO_ZONE_Y_MM;
  const zoneW = Math.min(PHOTO_ZONE_MAX_W_MM, page.width - 2 * PHOTO_ZONE_X_MM);
  const zoneH = page.height - PHOTO_ZONE_Y_MM - PHOTO_ZONE_BOTTOM_MARGIN_MM;
  const cells = packPhotoCells(targets.length, zoneW, zoneH);

  let changed = false;
  const elements = document.elements.slice() as SalesSheetElement[];
  targets.forEach((idx, k) => {
    const el = elements[idx];
    const cell = cells[k];
    const x = zoneX + cell.x;
    const y = zoneY + cell.y;
    if (el.x !== x || el.y !== y || el.w !== cell.w || el.h !== cell.h) {
      changed = true;
      elements[idx] = applyGeom(el, { x, y, w: cell.w, h: cell.h });
    }
  });
  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements } };
}

// ---------------------------------------------------------------------------
// レイアウト自動再バランス（写真枚数/概要表行数/間取り有無に応じて、テンプレ枠と写真を
// computeSpecSheetLayout の算出値へ再配置するワンボタン操作）。
// ---------------------------------------------------------------------------

/**
 * buildSpecSheetDocument が組む既知のテンプレ要素 id。これらの id を持つ要素だけを
 * 「テンプレ枠」として動かす（type==="image" 判定より優先）。floor-plan は type="image"
 * だが、この集合に含めることで写真ゾーン（L.photoSlots）ではなく専用の L.floorPlan で
 * 扱われるようにする（写真カウントに混入させない）。
 */
const TEMPLATE_ELEMENT_IDS = new Set([
  "catch-band",
  "catch-copy",
  "heading",
  "price",
  "overview",
  "sales-points",
  "company",
  "company-details",
  "floor-plan",
]);

/** x/y/w/h がすべて等しいか（幾何の変更検知用）。 */
function geomEquals(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * document を computeSpecSheetLayout（自社マイソク版面の最適化エンジン）で再バランスする。
 * autoArrangePhotos と同じ流儀（純・変更ゼロは同一 state 参照・変更あれば dirty=true）。
 *
 * - 動かすのは「既知idのテンプレ枠」（catch-band/catch-copy/heading/price/overview/
 *   sales-points/company/company-details/floor-plan）と「type==="image" の写真要素
 *   （既知id以外・配列順・枚数は任意）」のみ。未知idの非image要素（ユーザーが手で足した
 *   独自要素）は参照ごと不動。
 * - overview（id="overview" かつ type="table"）が存在すれば、その行数を specRowCount として
 *   エンジンへ渡す。フォント(style.fontSizePt)は overviewFontPt を渡さず、常にエンジンの
 *   自動計算（行数からの clamp）に委ねる — overview は table 要素で editText の対象外
 *   （ユーザーが直接フォントを変更する手段が無い）ため「ユーザー選択の保持」は成立せず、
 *   行数変化に追従した再計算が正しい（@review Fix B・build-document.ts のビルダー側も
 *   overviewFontPt を渡していないので一貫）。存在しなければ specRowCount=0。
 * - floor-plan は該当要素が存在する（hasFloorPlan）ときのみ、エンジンが返す非nullの
 *   L.floorPlan へ更新する。
 * - 写真（配列順）は L.photoSlots[k] の x/y/w/h へ更新する。src/fit/焦点/z/角丸/alt と
 *   配列内の位置は保持する。slots が足りない分（通常発生しない）は不動。
 * - 幾何(x/y/w/h)以外は一切変更しない（overview の style.fontSizePt のみ例外）。
 */
export function autoBalanceLayout(state: EditorState): EditorState {
  const { document } = state;
  const { elements } = document;

  const overviewIdx = elements.findIndex((e) => e.id === "overview" && e.type === "table");
  const overviewEl = overviewIdx === -1 ? null : (elements[overviewIdx] as TableElement);
  const specRowCount = overviewEl ? overviewEl.rows.length : 0;

  const hasFloorPlan = elements.some((e) => e.id === "floor-plan");

  const photoIdxs: number[] = [];
  elements.forEach((e, i) => {
    if (e.type === "image" && !TEMPLATE_ELEMENT_IDS.has(e.id)) photoIdxs.push(i);
  });

  // overviewFontPt は渡さない＝エンジンに specRowCount からフォントを再計算させる
  // （@review Fix B・table フォントは editText 対象外でユーザーが直接変更できないため、
  // 既存値の「保持」を優先する理由が無い）。
  const L = computeSpecSheetLayout({
    photoCount: photoIdxs.length,
    specRowCount,
    hasFloorPlan,
    footerHeight: DEFAULT_FOOTER_H,
  });

  const templateRects: Record<string, { x: number; y: number; w: number; h: number }> = {
    "catch-band": L.catchBand,
    "catch-copy": L.catchCopy,
    heading: L.heading,
    price: L.price,
    "sales-points": L.salesPoints,
    company: L.company,
    "company-details": L.companyDetails,
  };
  // 会社帯(footer-*)は自動調整の対象に含めない：ユーザーが編集画面で手動配置した
  // 会社帯レイアウトを「レイアウト自動調整」で消さずに保持するため（プロダクト判断）。
  // 会社帯は作成時の位置から出発し、以後の配置はユーザーの手動編集を優先する。

  let changed = false;
  const next = document.elements.slice() as SalesSheetElement[];

  for (const [id, rect] of Object.entries(templateRects)) {
    const idx = next.findIndex((e) => e.id === id);
    if (idx === -1) continue;
    const el = next[idx];
    if (!geomEquals(el, rect)) {
      changed = true;
      next[idx] = applyGeom(el, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    }
  }

  if (overviewIdx !== -1) {
    const el = next[overviewIdx] as TableElement;
    const rect = L.overview;
    if (!geomEquals(el, rect) || el.style.fontSizePt !== rect.fontSizePt) {
      changed = true;
      next[overviewIdx] = {
        ...el,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        style: { ...el.style, fontSizePt: rect.fontSizePt },
      };
    }
  }

  if (L.floorPlan) {
    const floorPlanRect = L.floorPlan;
    const idx = next.findIndex((e) => e.id === "floor-plan");
    if (idx !== -1) {
      const el = next[idx];
      if (!geomEquals(el, floorPlanRect)) {
        changed = true;
        next[idx] = applyGeom(el, {
          x: floorPlanRect.x,
          y: floorPlanRect.y,
          w: floorPlanRect.w,
          h: floorPlanRect.h,
        });
      }
    }
  }

  photoIdxs.forEach((idx, k) => {
    if (k >= L.photoSlots.length) return;
    const el = next[idx];
    const rect = L.photoSlots[k];
    if (!geomEquals(el, rect)) {
      changed = true;
      next[idx] = applyGeom(el, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    }
  });

  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements: next } };
}

/**
 * Clear the dirty flag (call after a successful save).
 */
export function markSaved(state: EditorState): EditorState {
  return { ...state, dirty: false };
}

/**
 * Clear the dirty flag ONLY if `savedDocument` is still the current document.
 *
 * Guards the in-flight-save race: if the user edits the canvas while a save (or
 * export auto-save) request is in flight, `state.document` becomes a newer
 * reference than the document that was actually persisted, so those later edits
 * must stay dirty. Reducers always return a new document reference on a change,
 * so identity comparison is sufficient.
 */
export function markSavedIfCurrent(
  state: EditorState,
  savedDocument: SalesSheetDocument,
): EditorState {
  if (state.document !== savedDocument) return state;
  return markSaved(state);
}

/**
 * Export orchestration with a save-race guard (plan-3 Task H / @codex).
 *
 * Export renders from the persisted (DB) document. If the editor is dirty we save
 * first, but a concurrent edit during the in-flight save keeps the editor dirty
 * (see {@link markSavedIfCurrent}) while the DB still holds the pre-edit version.
 * Exporting then would download a stale file that omits the latest visible edit
 * (breaks WYSIWYG). So when `save()` reports the editor did NOT end clean, abort
 * instead of exporting; the user can save again and re-export.
 *
 * `save()` MUST resolve `true` iff the editor ended clean (not dirty) after saving.
 */
export async function exportWithSaveGuard(opts: {
  dirty: boolean;
  save: () => Promise<boolean>;
  doExport: () => Promise<void>;
}): Promise<void> {
  if (opts.dirty) {
    const cleaned = await opts.save();
    if (!cleaned) {
      throw new Error("保存中に編集がありました。もう一度保存してから出力してください");
    }
  }
  await opts.doExport();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function findIdx(document: SalesSheetDocument, id: string): number {
  return document.elements.findIndex((e) => e.id === id);
}

/**
 * Apply geometry overrides to an element, returning a new element with the
 * same discriminant (type) preserved. The cast is safe because we only modify
 * fields common to all element variants (x, y, w, h, z).
 */
function applyGeom(
  el: SalesSheetElement,
  patch: Partial<{ x: number; y: number; w: number; h: number; z: number }>,
): SalesSheetElement {
  return { ...el, ...patch } as unknown as SalesSheetElement;
}

/**
 * Return new state with element at `idx` replaced and dirty=true.
 * All other elements and the document shape are preserved.
 */
function replaceElement(
  state: EditorState,
  idx: number,
  newEl: SalesSheetElement,
): EditorState {
  const elements = state.document.elements.slice() as SalesSheetElement[];
  elements[idx] = newEl;
  return {
    ...state,
    dirty: true,
    document: {
      ...state.document,
      elements,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
