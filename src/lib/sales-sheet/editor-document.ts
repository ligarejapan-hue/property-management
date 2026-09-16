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
import { buildMapsSearchUrl } from "./maps-url";
import {
  computeConsumerLayout,
  packPhotoCells,
  CONSUMER_PHOTO_ZONE,
  CONSUMER_PHOTO_RADIUS_MM,
  CONSUMER_PHOTO_Z,
  CONSUMER_MAP_QR_SLOT,
  PHOTO_GAP_MM,
  type Rect,
} from "./layout-engine";
import { packMosaic } from "./mosaic-pack";
import {
  buildConsumerFooterTransactionElements,
  readFooterData,
  footerDataEqual,
  type FooterBandData,
} from "./footer-band";
import {
  A4_LANDSCAPE,
  isConsumerTemplate,
  type SalesSheetDocument,
  type SalesSheetElement,
  type TextElement,
  type ImageElement,
  type BadgeElement,
  type QrElement,
  type TableElement,
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
 * 用紙外にはみ出した要素を用紙内へ引き戻す修復。
 * - 保存境界(assertSavableDocument)は ±10000mm 許容のため、ページ外(下端の外・右外・
 *   負座標)の要素が保存され得る。そうした要素はキャンバス上で見えず選択もできないため、
 *   図面を開いた時にこれを用紙内へ戻して編集・削除できるようにする。
 * - 各要素の原点を [0 .. page.width − w] × [0 .. page.height − h] にクランプ(サイズは不変)。
 *   用紙より大きい要素は左上(0,0)へ寄せる(下限が0未満にならないよう Math.max(0, …))。
 * - 純・冪等。用紙内に収まっている図面は同一参照で返す(no-op・dirty 化しない)。変更時のみ
 *   dirty=true。selectedId は保持。
 */
export function clampElementsToPage(state: EditorState): EditorState {
  const { document } = state;
  const { page } = document;
  let changed = false;
  const elements = document.elements.map((el) => {
    const x = clamp(el.x, 0, Math.max(0, page.width - el.w));
    const y = clamp(el.y, 0, Math.max(0, page.height - el.h));
    if (nearlyEqual(x, el.x) && nearlyEqual(y, el.y)) return el;
    changed = true;
    return applyGeom(el, { x, y });
  });
  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements } };
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
 * Resize element to (w, h), each clamped to [MIN_ELEMENT_SIZE_MM .. 用紙内]。
 * 上限クランプ(現原点から用紙右端/下端まで)は、キャンバス側の bounds を廃止した代わりに
 * 「保存境界(assertSavableDocument の A4 内検証)を resize で破れない」ことを担保する。
 * Sets dirty=true. No-op if id is not found.
 */
export function resizeElement(
  state: EditorState,
  id: string,
  size: { w: number; h: number },
): EditorState {
  const { document } = state;
  const { page } = document;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  // MIN が上限より優先(用紙右端ぎりぎりの要素でも最小サイズは維持=負/ゼロ寸法を返さない)。
  const w = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(size.w, page.width - el.x));
  const h = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(size.h, page.height - el.y));
  return replaceElement(state, idx, applyGeom(el, { w, h }));
}

/**
 * 1軸分のリサイズクランプ。どちらの端が「固定端」かを報告値から判定する:
 * - 原点(pos)が現値と同じ=右/下ハンドル → 原点固定でサイズのみクランプ。
 * - 原点が動いた=左/上ハンドル → 反対端(pos+size)が固定端。最小サイズ/用紙境界で
 *   クランプしても固定端を保ち、原点側だけを動かす(固定端がズレると要素が滑る・
 *   @codex #294 P2)。
 */
function clampResizeAxis(
  cur: number,
  pos: number,
  size: number,
  pageLen: number,
): { pos: number; size: number } {
  const EPS = 0.01;
  if (Math.abs(pos - cur) <= EPS) {
    // 右/下ハンドル: 原点固定。
    return { pos: cur, size: Math.max(MIN_ELEMENT_SIZE_MM, Math.min(size, pageLen - cur)) };
  }
  // 左/上ハンドル: 反対端固定(用紙内・最小サイズ分は確保)。
  const fixedEnd = clamp(pos + size, MIN_ELEMENT_SIZE_MM, pageLen);
  const clamped = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(size, fixedEnd));
  return { pos: fixedEnd - clamped, size: clamped };
}

/**
 * リサイズ確定でサイズと原点が同時に変わる(top/leftハンドル)場合の一括適用。
 * moveElement→resizeElement の順次適用では、互いのクランプが「相手の旧値」を使い
 * 右端/下端付近の要素で位置やサイズが歪む(@codex #294 P2)。軸ごとに固定端を
 * 判定して整合的にクランプする(clampResizeAxis)。
 */
export function resizeElementWithOrigin(
  state: EditorState,
  id: string,
  geom: { x: number; y: number; w: number; h: number },
): EditorState {
  const { document } = state;
  const { page } = document;
  const idx = findIdx(document, id);
  if (idx === -1) return state;
  const el = document.elements[idx];
  const ax = clampResizeAxis(el.x, geom.x, geom.w, page.width);
  const ay = clampResizeAxis(el.y, geom.y, geom.h, page.height);
  return replaceElement(state, idx, applyGeom(el, { x: ax.pos, y: ay.pos, w: ax.size, h: ay.size }));
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

/** 地図QR(物件の場所の Google マップ QR)の固定 id。1枚のみ。 */
export const MAP_QR_ID = "map-qr";

/**
 * 物件の住所から Google マップ検索の QR を作り、会社帯右端の枠(CONSUMER_MAP_QR_SLOT)に置く。
 * - 旧ひな型では何もしない(枠が旧会社帯と重なるため)。住所空/生成不能も同一参照。
 * - 既存の地図QRは置き換え(1枚)。写真や間取り図は動かさない。z=最前面・自動選択・dirty。
 */
export function addMapQrElement(state: EditorState, params: { address: string }): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document)) return state;
  const url = buildMapsSearchUrl(params.address);
  if (url === null) return state;
  const dataUrl = generateQrDataUrl(url);
  if (dataUrl === null) return state;
  const base = document.elements.filter((e) => e.id !== MAP_QR_ID);
  const z = base.length ? Math.max(...base.map((e) => e.z)) + 1 : 1;
  const slot = CONSUMER_MAP_QR_SLOT;
  const mapQrEl: QrElement = { id: MAP_QR_ID, type: "qr", x: slot.x, y: slot.y, w: slot.w, h: slot.h, z, dataUrl, content: url };
  return {
    ...state,
    dirty: true,
    selectedId: MAP_QR_ID,
    document: { ...document, elements: [...base, mapQrEl] },
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
 * 会社帯の物件別6項目をまとめて更新する(取引条件/担当の表だけ作り直す)。
 * - 旧ひな型・footer-band の無い図面・値が同じときは同一参照。
 * - 作り直した表は、元の取引表があった位置(配列順)に入れる。
 */
export function editFooterData(state: EditorState, data: FooterBandData): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document)) return state;
  const band = document.elements.find((e) => e.id === "footer-band");
  if (!band) return state;
  if (footerDataEqual(readFooterData(document.elements), data)) return state;

  const regenerated = buildConsumerFooterTransactionElements({ x: band.x, y: band.y, w: band.w, h: band.h }, data);
  const TX_IDS = new Set(["footer-terms-table", "footer-staff-table"]);
  const elements: SalesSheetElement[] = [];
  let inserted = false;
  for (const el of document.elements) {
    if (TX_IDS.has(el.id)) {
      if (!inserted) {
        elements.push(...regenerated);
        inserted = true;
      }
      continue;
    }
    elements.push(el);
  }
  if (!inserted) elements.push(...regenerated);
  return { ...state, dirty: true, document: { ...document, elements } };
}

// ---------------------------------------------------------------------------
// 自動レイアウト（計画⑥）
// ---------------------------------------------------------------------------

/** A4横の図面か(新しい紙面の計算は A4横専用)。 */
function isA4Landscape(document: SalesSheetDocument): boolean {
  return document.page.width === A4_LANDSCAPE.width && document.page.height === A4_LANDSCAPE.height;
}

/**
 * 作成直後(build-document の packPhotoCells グリッド)のまま、まだ誰も写真に触っていないか。
 *
 * 作成時はサーバーに写真の実寸比が無いため均等グリッドで置くしかなく、枚数によっては
 * 縦積みの細長い帯になる。実寸比が分かるのはブラウザで描画したときだけなので、編集画面を
 * 最初に開いた一度だけ autoArrangePhotos(=「自動整列」ボタン)へ寄せる。その門番。
 * 人が1枚でも動かす/大きさを変える、または一度整列した後は false になり、以後の open で
 * 紙面を勝手に組み替えない。純関数。
 */
export function isInitialPhotoGrid(document: SalesSheetDocument): boolean {
  if (!isConsumerTemplate(document) || !isA4Landscape(document)) return false;
  const images = document.elements.filter((e): e is ImageElement => e.type === "image");
  if (images.length === 0) return false;
  const zone = CONSUMER_PHOTO_ZONE;
  const cells = packPhotoCells(images.length, zone.w, zone.h);
  return images.every((el, i) => {
    const c = cells[i];
    return (
      nearlyEqual(el.x, zone.x + c.x) &&
      nearlyEqual(el.y, zone.y + c.y) &&
      nearlyEqual(el.w, c.w) &&
      nearlyEqual(el.h, c.h) &&
      // 枠は動かさずに見せ方だけ変えた図面(contain→cover・焦点位置の指定)も「触った」
      // とみなす。位置と大きさだけで判定すると、開いただけで autoArrangePhotos が
      // fit を contain に戻し、保存済みの設定を黙って消す(@codex #432 P2)。
      // ⚠build-document の photoAndFloorPlanElements が作成時に決める項目は、ここで
      // 全て突き合わせる(位置/大きさ/重ね順/表示方法/焦点位置/角丸)。1つでも
      // 見落とすと、その項目だけ変えた図面を「作成直後」と誤判定して組み替える。
      el.z === CONSUMER_PHOTO_Z &&
      el.fit === "contain" &&
      el.focalX === undefined &&
      el.focalY === undefined &&
      // 角丸も見た目の設定(ElementPanel から変えられる)。既定は役割で違う
      // (写真=CONSUMER_PHOTO_RADIUS_MM・間取り図=無し)。どちらの既定も一律に許すと、
      // 間取り図に角丸を付けた/写真の角丸を外した図面を作成直後と誤判定する(@codex #432 P2)。
      el.radiusMm === (el.id === "floor-plan" ? undefined : CONSUMER_PHOTO_RADIUS_MM)
    );
  });
}

/**
 * 写真と間取り図(type=image すべて)を写真枠(CONSUMER_PHOTO_ZONE)へモザイク配置で並べ直す。
 * - 旧ひな型・A4横以外は同一参照。
 * - 並び順=配列順(代表写真が先頭)。opts.appendedId は末尾。
 * - 枠は実寸比(opts.aspects[id]・無ければ現枠の w/h)を保つ。fit:"contain"。
 * - 純・決定的。変更ゼロなら同一参照。
 */
export function autoArrangePhotos(
  state: EditorState,
  opts?: { appendedId?: string; aspects?: Record<string, number> },
): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document) || !isA4Landscape(document)) return state;
  const targets: number[] = [];
  document.elements.forEach((e, i) => {
    if (e.type === "image") targets.push(i);
  });
  if (targets.length === 0) return state;

  const ordered = targets.slice();
  if (opts?.appendedId) {
    const k = ordered.findIndex((idx) => document.elements[idx].id === opts.appendedId);
    if (k >= 0) ordered.push(...ordered.splice(k, 1));
  }
  const aspects = ordered.map((idx) => {
    const el = document.elements[idx];
    return opts?.aspects?.[el.id] ?? (el.h > 0 ? el.w / el.h : 0);
  });
  const zone = CONSUMER_PHOTO_ZONE;
  const rects = packMosaic(aspects, zone.w, zone.h, PHOTO_GAP_MM);

  let changed = false;
  const elements = document.elements.slice() as SalesSheetElement[];
  ordered.forEach((idx, k) => {
    const el = elements[idx] as ImageElement;
    const r = rects[k];
    const x = zone.x + r.x;
    const y = zone.y + r.y;
    if (!nearlyEqual(el.x, x) || !nearlyEqual(el.y, y) || !nearlyEqual(el.w, r.w) || !nearlyEqual(el.h, r.h) || el.fit !== "contain") {
      changed = true;
      elements[idx] = { ...el, x, y, w: r.w, h: r.h, fit: "contain" };
    }
  });
  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements } };
}

/** 幾何座標の等値判定(1/1000mm 許容・整列の冪等性用)。 */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/** 実寸比の表を、id の付け替えに合わせて写し替える(元の表は変えない)。 */
function renameAspects(
  aspects: Record<string, number> | undefined,
  renames: [from: string, to: string][],
): Record<string, number> | undefined {
  if (!aspects) return undefined;
  const out = { ...aspects };
  for (const [from, to] of renames) {
    // from に実寸比が無ければ to も消す。out は aspects のコピーのため、
    // to が別の付け替えで既に値を持っている(古い写真の実寸比が残っている)
    // ことがあり、消さないと無関係な画像の比率を使い回してしまう(F3)。
    if (aspects[from] !== undefined) out[to] = aspects[from];
    else delete out[to];
  }
  return out;
}

/**
 * 選んだ写真を間取り図(id="floor-plan")にする。既存の間取り図は demotedId の写真に戻す(常に1枚)。
 * 位置は写真枠の並べ直しに任せる(旧ひな型では並べ直さない)。selectedId は "floor-plan"。
 */
export function setAsFloorPlan(
  state: EditorState,
  id: string,
  demotedId: string,
  aspects?: Record<string, number>,
): EditorState {
  const { document } = state;
  const idx = document.elements.findIndex((e) => e.id === id);
  if (idx === -1) return state;
  const target = document.elements[idx];
  if (target.type !== "image" || target.id === "floor-plan") return state;

  const elements = document.elements.slice() as SalesSheetElement[];
  const existingIdx = elements.findIndex((e) => e.id === "floor-plan");
  if (existingIdx !== -1) elements[existingIdx] = { ...elements[existingIdx], id: demotedId } as SalesSheetElement;
  elements[idx] = { ...(target as ImageElement), id: "floor-plan", fit: "contain" };
  const next: EditorState = { ...state, dirty: true, selectedId: "floor-plan", document: { ...document, elements } };
  const renamed = renameAspects(aspects, [["floor-plan", demotedId], [id, "floor-plan"]]);
  return autoArrangePhotos(next, renamed ? { aspects: renamed } : undefined);
}

/** 間取り図(id="floor-plan")を newId の写真に戻す。無ければ同一参照。selectedId は newId。 */
export function unsetFloorPlan(
  state: EditorState,
  newId: string,
  aspects?: Record<string, number>,
): EditorState {
  const { document } = state;
  const idx = document.elements.findIndex((e) => e.id === "floor-plan" && e.type === "image");
  if (idx === -1) return state;
  const elements = document.elements.slice() as SalesSheetElement[];
  elements[idx] = { ...elements[idx], id: newId } as SalesSheetElement;
  const next: EditorState = { ...state, dirty: true, selectedId: newId, document: { ...document, elements } };
  const renamed = renameAspects(aspects, [["floor-plan", newId]]);
  return autoArrangePhotos(next, renamed ? { aspects: renamed } : undefined);
}

/** x/y/w/h がすべて等しいか（幾何の変更検知用）。 */
function geomEquals(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * 定型項目・表・写真・地図QRを、computeConsumerLayout の標準位置へ戻す(「レイアウト自動調整」)。
 * - 旧ひな型・A4横以外は同一参照。
 * - 表(overview / overview-detail-a / -b)は行数から文字サイズも計算し直す。
 * - 写真と間取り図は写真枠へ均等に置く(エディタが続けてモザイク整列で仕上げる)。
 * - 会社帯(footer-*)と利用者が足した要素は動かさない。変更ゼロなら同一参照。
 */
export function autoBalanceLayout(state: EditorState): EditorState {
  const { document } = state;
  if (!isConsumerTemplate(document) || !isA4Landscape(document)) return state;
  const rowsOf = (id: string): number => {
    const el = document.elements.find((e) => e.id === id);
    return el && el.type === "table" ? el.rows.length : 0;
  };
  const L = computeConsumerLayout({
    mainRowCount: rowsOf("overview"),
    detailRowCount: rowsOf("overview-detail-a") + rowsOf("overview-detail-b"),
    detailPerColumn: Math.max(rowsOf("overview-detail-a"), rowsOf("overview-detail-b")),
  });
  const rects = new Map<string, Rect>([
    ["catch-band", L.catchBand],
    ["catch-copy", L.catchCopy],
    ["kind-tag", L.kindTag],
    ["heading", L.heading],
    ["price", L.price],
    ["sales-points-band", L.salesPointsBand],
    ["sales-points", L.salesPoints],
    [MAP_QR_ID, L.mapQrSlot],
  ]);
  const tables = new Map<string, { rect: Rect; fontSizePt: number }>([
    ["overview", { rect: L.mainTable, fontSizePt: L.mainTable.fontSizePt }],
    ["overview-detail-a", { rect: L.detailLeft, fontSizePt: L.detailFontSizePt }],
    ["overview-detail-b", { rect: L.detailRight, fontSizePt: L.detailFontSizePt }],
  ]);

  let changed = false;
  const next = document.elements.slice() as SalesSheetElement[];
  next.forEach((el, i) => {
    const table = tables.get(el.id);
    if (table && el.type === "table") {
      const r = table.rect;
      if (!geomEquals(el, r) || el.style.fontSizePt !== table.fontSizePt) {
        changed = true;
        next[i] = { ...el, x: r.x, y: r.y, w: r.w, h: r.h, style: { ...el.style, fontSizePt: table.fontSizePt } };
      }
      return;
    }
    const r = rects.get(el.id);
    if (r && !geomEquals(el, r)) {
      changed = true;
      next[i] = applyGeom(el, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
  });

  const imageIdxs: number[] = [];
  next.forEach((e, i) => {
    if (e.type === "image") imageIdxs.push(i);
  });
  const zone = L.photoZone;
  const cells = packPhotoCells(imageIdxs.length, zone.w, zone.h);
  imageIdxs.forEach((idx, k) => {
    const c = cells[k];
    const r = { x: zone.x + c.x, y: zone.y + c.y, w: c.w, h: c.h };
    if (!geomEquals(next[idx], r)) {
      changed = true;
      next[idx] = applyGeom(next[idx], r);
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

// ---------------------------------------------------------------------------
// B-8 (UI総点検): 文字・表どうしの重なり検知 (read-only)
// ---------------------------------------------------------------------------

export interface TextTableOverlapPair {
  aId: string;
  bId: string;
}

/** 実質的な重なりとみなす最小の食い込み (mm)。隣接・微小接触は除外する。 */
const OVERLAP_TOLERANCE_MM = 0.5;

/** pt → mm 換算 (1pt = 25.4/72 mm)。 */
const PT_TO_MM = 25.4 / 72;

/** monospace 系フォントか (ASCII の字送りが均一 ≒0.6em になる)。 */
function isMonospaceFamily(family: string | undefined): boolean {
  return !!family && /mono|courier|consolas|menlo/i.test(family);
}


/**
 * 表の描画上の高さの概算 (mm)。
 *
 * レンダラ (SalesSheetRenderer / render-html) は非 borderless(旧ひな型)の
 * <table> を直接絶対配置するため、CSS の height は最小値扱いで、行数の増加や
 * セル内の折返しで保存 h を超えて描画される (overflow:hidden は table 要素
 * 自身の行を切り取らない・@codex #310)。borderless(消費者向けひな型)の表は
 * 外側の <div> が overflow:hidden で実際に切り取るため保存 h を超えない
 * (この関数の呼び出し側 findTextTableOverlaps は borderless では使わない・F1)。
 * 行ごとに「セル幅(label 32% / value 68%)に収まらない分の折返し行数」を
 * 全角=フォント幅 1 文字分として概算する (厳密なテキスト実測はしない)。
 */
function estimatedTableHeightMm(el: TableElement, mono: boolean, maxHeightMm: number): number {
  const fontMm = (el.style.fontSizePt ?? 12) * PT_TO_MM;
  const lineMm = fontMm * 1.3;
  // 余白: 未指定は従来の 0.5mm 1mm。指定時は上下=値・左右=値×1.2(table-cell-style と同じ)。
  const padV = el.style.cellPaddingMm ?? 0.5;
  const padH = el.style.cellPaddingMm !== undefined ? el.style.cellPaddingMm * 1.2 : 1;
  const rowExtraMm = padV * 2 + (el.style.borderless ? 0 : 0.4);
  const labelW = Math.max(el.w * 0.32 - padH * 2, fontMm);
  const valueW = Math.max(el.w * 0.68 - padH * 2, fontMm);
  const labelChars = Math.max(0.1, labelW / fontMm);
  const valueChars = Math.max(0.1, valueW / fontMm);
  const lineCap = Math.max(1, Math.ceil(maxHeightMm / lineMm));
  const cellLines = (s: string, chars: number): number =>
    measureParagraph(s, chars, mono, lineCap + 1, true).length;
  let total = 0;
  for (const r of el.rows) {
    const rowLines = Math.max(cellLines(r.label, labelChars), cellLines(r.value, valueChars));
    total += rowLines * lineMm + rowExtraMm;
    if (total >= maxHeightMm) return total;
  }
  return total;
}

/**
 * セル内で折返し不可な最長の塊 (em)。折返し可能点はテキストと同じ
 * (空白/タブ/改行/ハイフン・スラッシュの直後)。capEm で走査を打ち切る。
 */
function maxUnbreakableRunEm(
  s: string,
  mono: boolean,
  capEm: number,
): number {
  const WIDE_ASCII = /[MWmw@#%&]/;
  const NARROW_ASCII = /[ijlI.,;:!'|]/;
  // ページ内 (可視域) に描かれ得る「グリフ文字数」を大きく超える走査はしない
  // (@codex #310 R33: 区切りの多い巨大セル値でも全走査で UI を塞がない)。
  // 空白 run は予算に数えず native 検索で読み飛ばす (@codex #310 R34: セルは
  // white-space: normal で空白が潰れるため、先頭に大量の空白があっても後続の
  // 塊はセル先頭に描画される = 空白で予算を消費して見逃してはいけない)
  const SCAN_CHAR_CAP = 10000;
  const NON_WS = /[^ \t\n\r]/g;
  let scanned = 0;
  let run = 0;
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch.charCodeAt(0) <= 0xff) {
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        max = Math.max(max, run);
        run = 0;
        // 空白 run を一括スキップ (予算外)
        NON_WS.lastIndex = i + 1;
        const m = NON_WS.exec(s);
        i = (m ? m.index : s.length) - 1;
        continue;
      }
      if (++scanned > SCAN_CHAR_CAP) break;
      run += mono
        ? 0.6
        : WIDE_ASCII.test(ch)
          ? 0.9
          : NARROW_ASCII.test(ch)
            ? 0.35
            : /[A-Z]/.test(ch)
              ? 0.7
              : 0.6;
      if (ch === "-" || ch === "/") {
        max = Math.max(max, run);
        run = 0;
      }
      // 成長中の run 自体も上限で打ち切る (@codex #310 R31: 区切りの無い
      // 巨大トークンでは max が更新されず走査が止まらない)
      if (run >= capEm || max >= capEm) return capEm;
      continue;
    }
    if (++scanned > SCAN_CHAR_CAP) break;
    max = Math.max(max, run);
    run = 0;
  }
  return Math.min(capEm, Math.max(max, run));
}

/**
 * 表の描画上の実効幅 (mm)。
 *
 * table 要素の overflow: hidden は table box には効かず、セル内の折返し不可な
 * 長い値 (URL・識別子) はセル・表の右へはみ出して描画される (@codex #310 R23)。
 * label セル(左端+padding≒1.2mm)・value セル(表幅の32%+1.2mm)それぞれの
 * 最長不可分塊の到達位置と保存幅の大きい方を返す。
 */
function estimatedTableWidthMm(
  el: TableElement,
  mono: boolean,
  maxWidthMm: number,
): number {
  const fontMm = (el.style.fontSizePt ?? 12) * PT_TO_MM;
  const capEm = Math.ceil(maxWidthMm / fontMm);
  let labelMaxEm = 0;
  let valueMaxEm = 0;
  for (const r of el.rows) {
    labelMaxEm = Math.max(labelMaxEm, maxUnbreakableRunEm(r.label, mono, capEm));
    valueMaxEm = Math.max(valueMaxEm, maxUnbreakableRunEm(r.value, mono, capEm));
    if (labelMaxEm >= capEm && valueMaxEm >= capEm) break;
  }
  const labelReach = 1.2 + labelMaxEm * fontMm;
  const valueReach = el.w * 0.32 + 1.2 + valueMaxEm * fontMm;
  return Math.min(maxWidthMm, Math.max(el.w, labelReach, valueReach));
}

/**
 * text 要素の「実際に文字が描画される範囲」の概算 (mm)。
 *
 * 手動リサイズで箱だけ大きい text は、透明な余白部分に表が重なっても出力上は
 * 何も重ならない (@codex #310 R5: 箱全体で判定すると消せない誤警告になる)。
 * 折返し(箱幅・全角=フォント幅1文字)と行数から文字域を見積り、textAlign に
 * 応じて箱内の位置を決める (縦方向は上詰め描画)。
 */
/**
 * 段落 1 つの折返し行数と最大行幅 (実効文字数) の概算。
 *
 * レンダラの text は white-space: pre-wrap のみで overflow-wrap を持たないため、
 * 連続する非空白 ASCII (識別子・URL 等) は塊内で折り返されず横方向に clip される
 * (@codex #310 R7: 塊を charsPerLine で機械的に割ると縦に伸びない文字を伸びた
 * 扱いにして誤検知する)。全角は 1 文字ごと・空白位置では折返し可として
 * 貪欲に行詰めする。
 */
function measureParagraph(
  para: string,
  charsPerLine: number,
  mono: boolean,
  maxLines: number,
  collapseWs: boolean,
): MeasuredLine[] {
  // ASCII の字送り: monospace は均一 ≒0.6em (Courier 等。1em はフォントサイズで
  // ありグリフ幅ではない・@codex #310 R11)。プロポーショナルは段階化する
  // (@codex #310 R10/R13: 一律だと過小/過大の双方が出る):
  //   幅広 (M/W/m/w/@/#/%/&) = 0.9em / 細身 (i/j/l/I/約物) = 0.35em /
  //   その他大文字 = 0.7em / その他 = 0.6em
  const WIDE_ASCII = /[MWmw@#%&]/;
  const NARROW_ASCII = /[ijlI.,;:!'|]/;
  const charEm = (ch: string): number => {
    if (mono) return 0.6;
    if (WIDE_ASCII.test(ch)) return 0.9;
    if (NARROW_ASCII.test(ch)) return 0.35;
    if (/[A-Z]/.test(ch)) return 0.7;
    return 0.6;
  };
  // 空白 (U+0020) の字送り: monospace は他と同じ 0.6em・プロポーショナルの
  // 空白グリフは細く ≒0.3em (@codex #310 R27: 0.6em だとタブストップと行詰めが
  // 実描画より右へ伸びて誤検知する)。
  const SPACE_EM = mono ? 0.6 : 0.3;
  // タブストップ幅: ブラウザ既定 tab-size:8 = 空白8個分
  // (@codex #310 R14: タブを空白1個で数えると貼り付けた表形式文字列を過小見積り)
  const TAB_STOP_EM = 8 * SPACE_EM;

  // 単一パスの貪欲行詰め。maxLines 行が確定した時点で走査を打ち切る
  // (@codex #310 R16/R18: 巨大貼り付けの同期計測対策を文字数 slice でなく
  // 行数上限で行う = 長大な不可分塊の後に続く可視テキストを取りこぼさない)。
  // 行ごとに「先頭の空白送り (lead)」と「グリフ域 (glyph)」を分けて記録する
  // (@codex #310 R30: 先頭/行末の空白域は描画されないため矩形に含めない)。
  const lines: MeasuredLine[] = [];
  let cur = 0; // 行の総送り (lead + glyph + trail)
  let lead = 0; // 行頭からグリフ開始までの空白送り
  let trail = 0; // 最後のグリフ以降の空白送り
  let hasGlyph = false;
  let asciiRun = 0;
  let sawContent = false;
  let pendingWs = false; // collapseWs 用 (連続空白を 1 個に潰す)
  // 直前が clip 済み不可分塊の行末で、新しい行にまだ何も無い状態。
  // この直後の改行は「clip 行を終えるだけ」で新しい空行を作らない
  // (@codex #310 R20: 幻の空行で以降の行がズレるのを防ぐ)。
  let afterClip = false;
  const pushLine = (): void => {
    lines.push({ lead, glyph: Math.max(0, cur - lead - trail) });
    cur = 0;
    lead = 0;
    trail = 0;
    hasGlyph = false;
  };
  const addWs = (adv: number): void => {
    cur += adv;
    if (hasGlyph) trail += adv;
    else lead += adv;
  };
  const emitSpace = (): void => {
    afterClip = false;
    if (cur + SPACE_EM > charsPerLine) pushLine();
    addWs(SPACE_EM);
  };
  const emitBlock = (w: number): void => {
    if (pendingWs) {
      pendingWs = false;
      emitSpace();
    }
    if (w > charsPerLine) {
      // 行に収まらない折返し不可塊 = 単独 1 行で横 clip (縦には伸びない)。
      // clip 行のグリフは箱の右端まで描かれて切れるため、幅は「全幅」として
      // 記録する (@codex #310 R21: charsPerLine×字送りだと端数分だけ狭くなる)。
      if (cur > 0) pushLine();
      lines.push({ lead: 0, glyph: Number.POSITIVE_INFINITY });
      cur = 0;
      lead = 0;
      trail = 0;
      hasGlyph = false;
      afterClip = true;
      return;
    }
    afterClip = false;
    if (cur + w > charsPerLine) pushLine();
    hasGlyph = true;
    trail = 0;
    cur += w;
  };
  // 飽和した不可分塊 (既に clip 確定) の残りを一括スキップするための
  // 折返し可能点スキャナ (@codex #310 R25: 数百万文字の不可分連続でも
  // native 検索で読み飛ばし、1 文字ずつの走査で main thread を塞がない)
  const BREAK_SCAN = /[ \t\n\r\-/]|[^\x00-\xff]/g;
  // 送り幅ゼロの結合文字 (結合分音記号・濁点/半濁点・異体字セレクタ・ZWJ/ZWSP)。
  // レンダラは直前のグリフに合成して描くため幅に数えない (@codex #310 R28)。
  const isZeroAdvance = (code: number): boolean =>
    (code >= 0x0300 && code <= 0x036f) ||
    code === 0x3099 ||
    code === 0x309a ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x200d ||
    code === 0x200b;
  let joinNext = false; // ZWJ 直後のグリフは前と合成され 1 グリフになる
  let prevWasCr = false;
  for (let i = 0; i < para.length; i++) {
    const ch = para[i];
    if (lines.length >= maxLines) return lines; // 可視行ぶん確定済み
    // CRLF/CR は 1 つの改行として扱う (@codex #310 R22: \r を印字グリフとして
    // 0.6em 加算しない。レンダラは \r\n を 1 つの改行として描く)
    if (ch === "\n" && prevWasCr) {
      prevWasCr = false;
      continue;
    }
    prevWasCr = ch === "\r";
    const isBreak = ch === "\n" || ch === "\r";
    if (!collapseWs && isBreak) {
      // pre-wrap の改行 = 強制改行 (@codex #310 R19: split("\n") で全文を
      // 走査/確保せず、単一パス内で段落境界を処理して行数上限で打ち切る)
      if (asciiRun > 0) {
        emitBlock(asciiRun);
        asciiRun = 0;
      }
      if (afterClip && cur === 0) {
        // clip 行の直後の改行は行を増やさない (@codex R20)
        afterClip = false;
        continue;
      }
      pushLine();
      continue;
    }
    const isWs = ch === " " || ch === "\t" || (collapseWs && isBreak);
    if (!isWs && ch.charCodeAt(0) <= 0xff) {
      sawContent = true;
      asciiRun += charEm(ch);
      if (ch === "-" || ch === "/") {
        // ハイフン/スラッシュの直後は CSS の折返し可能点 (@codex #310 R9/R19:
        // URL・パスはスラッシュ位置で実際に折り返されて縦に伸びる)
        emitBlock(asciiRun);
        asciiRun = 0;
      } else if (asciiRun > charsPerLine) {
        // この塊は clip 確定 (@codex R25)。残りは次の折返し可能点まで
        // 一括スキップ (幅は既に飽和しており結果に影響しない)
        BREAK_SCAN.lastIndex = i + 1;
        const m = BREAK_SCAN.exec(para);
        i = (m ? m.index : para.length) - 1;
      }
      continue;
    }
    if (asciiRun > 0) {
      emitBlock(asciiRun);
      asciiRun = 0;
    }
    if (isWs) {
      if (collapseWs) {
        // セル (white-space: normal) は連続空白を 1 個に潰し、先頭空白は捨てる
        if (sawContent) pendingWs = true;
      } else if (afterClip && cur === 0) {
        // clip 行の直後の空白/タブは clip 行の行末に掛かる (pre-wrap は行末
        // 空白を次行へ送らない) ため、新しい行を作らない (@codex #310 R32)。
        // afterClip は維持し、続く改行も clip 行を終えるだけにする。
      } else if (ch === "\t") {
        // 次のタブストップへ送る (行幅は超えない)。タブ自体は折返し可能点。
        afterClip = false;
        addWs(
          Math.min(
            charsPerLine,
            (Math.floor(cur / TAB_STOP_EM) + 1) * TAB_STOP_EM,
          ) - cur,
        );
      } else {
        emitSpace();
      }
    } else {
      const code = ch.charCodeAt(0);
      // ゼロ送りの結合文字は幅に数えない (@codex #310 R28)
      if (isZeroAdvance(code)) {
        if (code === 0x200d) joinNext = true;
        continue;
      }
      // サロゲートペア (絵文字等) は 1 グリフ = 全角 1 文字として数える
      // (@codex #310 R26: UTF-16 の 2 単位を 2 文字分にしない)
      if (code >= 0xd800 && code <= 0xdbff) {
        const cp = para.codePointAt(i) ?? 0;
        i++;
        // 肌色モディファイア (U+1F3FB..U+1F3FF) は直前の絵文字に合成される
        // (@codex #310 R29: 別グリフとして数えると約2倍幅の誤検知)
        if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue;
      }
      if (joinNext) {
        // ZWJ 連結 (家族絵文字等) は直前のグリフと合成され幅を増やさない
        joinNext = false;
        continue;
      }
      sawContent = true;
      emitBlock(1); // 全角 1 文字 (どこでも折返し可)
    }
  }
  if (asciiRun > 0) emitBlock(asciiRun);
  if (collapseWs && !sawContent) return []; // 空セルは文字行を作らない (R15)
  if (cur > 0 || lines.length === 0) pushLine();
  return lines;
}

/**
 * 完全に透明な文字色か (transparent / rgba(...,0) / #RGB0 / #RRGGBB00)。
 * 透明な text は描画されないため重なり判定の対象外にする (@codex #310 R35)。
 */
function isFullyTransparentColor(color: string | undefined): boolean {
  if (!color) return false;
  const c = color.trim().toLowerCase();
  if (c === "transparent") return true;
  // rgb()/rgba()/hsl()/hsla(): カンマ区切り第4成分か、CSS Color 4 の
  // スラッシュ記法 (rgb(0 0 0 / 0)) のどちらでも alpha を読む (@codex #310 R36)
  const fn = c.match(/^(?:rgba?|hsla?)\(([^)]*)\)$/);
  if (fn) {
    const inner = fn[1];
    let alphaStr: string | undefined;
    if (inner.includes("/")) {
      alphaStr = inner.split("/")[1];
    } else {
      const parts = inner.split(",");
      alphaStr = parts.length >= 4 ? parts[3] : undefined;
    }
    if (alphaStr === undefined) return false; // alpha 未指定 = 不透明
    return parseFloat(alphaStr) === 0;
  }
  if (/^#[0-9a-f]{4}$/.test(c)) return c[4] === "0";
  if (/^#[0-9a-f]{8}$/.test(c)) return c.slice(-2) === "00";
  return false;
}

interface MeasuredLine {
  /** 行頭からグリフ開始までの空白送り (em)。clip 行は 0 */
  lead: number;
  /** グリフ域の送り (em)。clip 行は Infinity = 箱の全幅 */
  glyph: number;
}

interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * text 要素の描画行ごとの矩形 (mm)。
 *
 * 複数行を 1 枚の外接矩形にすると、短い行の横の余白まで「文字がある」扱いに
 * なり誤検知する (@codex #310 R13)。行ごとに幅と textAlign を反映した矩形を
 * 返し、箱の高さを超える行は clip (overflow hidden) として捨てる。
 */
function textRenderedLineRectsMm(el: TextElement, mono: boolean): RectMm[] {
  const fontMm = (el.style.fontSizePt ?? 12) * PT_TO_MM;
  const lineMm = fontMm * (el.style.lineHeight ?? 1.2);
  // 行容量 (em) は端数を保つ (@codex #310 R24)
  const charsPerLine = Math.max(0.1, el.w / fontMm);
  // 箱の高さを超える行は描画されない (overflow hidden) ため、計測も可視行数で
  // 打ち切る (@codex #310 R16/R18: 巨大な貼り付けで useMemo の同期計測が
  // main thread を塞がない。文字数 slice でなく行数上限で打ち切ることで、
  // 長大な不可分塊の後に続く可視テキストを取りこぼさない)。
  const maxLines = Math.max(1, Math.ceil(el.h / lineMm));
  // 改行は measureParagraph が単一パス内で強制改行として扱う (split("\n") で
  // 全文を確保しない・@codex #310 R19)。
  const lineChars = measureParagraph(el.content, charsPerLine, mono, maxLines, false);
  const rects: RectMm[] = [];
  for (let i = 0; i < lineChars.length; i++) {
    const top = i * lineMm;
    if (top >= el.h) break; // 箱の外は描画されない (overflow: hidden)
    const line = lineChars[i];
    if (line.glyph <= 0) continue; // 空白のみ/空行は描画されない
    // 先頭空白 (lead) の空白域は矩形に含めない (@codex #310 R30)
    const leadMm = Math.min(line.lead * fontMm, el.w);
    const glyphMm = Number.isFinite(line.glyph)
      ? line.glyph * fontMm
      : el.w; // clip 行は箱の全幅
    const totalMm = Math.min(el.w, leadMm + glyphMm);
    const base =
      el.style.align === "right"
        ? el.x + (el.w - totalMm)
        : el.style.align === "center"
          ? el.x + (el.w - totalMm) / 2
          : el.x;
    const x = base + leadMm;
    const w = Math.min(glyphMm, el.x + el.w - x);
    if (w <= 0) continue;
    rects.push({ x, y: el.y + top, w, h: Math.min(lineMm, el.h - top) });
  }
  return rects;
}

/**
 * 文字 (text) と表 (table) どうしの矩形重なりを列挙する (document は不変)。
 *
 * 自動整列/自動調整は自由配置の文字・表を動かさない仕様 (手動配置の尊重) の
 * ため、重なったままだと PDF/PNG 出力にもそのまま残る。編集画面で注意を出す
 * ための検知専用ヘルパ。写真の上の文字や帯 (shape) の上の見出しは意図的な
 * 重なりの定番なので対象外 (text/table 以外は見ない)。
 * - 空文字の text (テンプレが保持する未入力の price 等) は見えないため対象外
 *   (@codex #310: 見えない箱との交差で警告しない)
 * - text は箱全体でなく「文字が描画される範囲」の概算で判定 (箱だけ大きい
 *   text の透明余白では警告しない・@codex #310 R5)
 * - 表は保存 h と「行数・折返しから見積もった描画上の高さ」の大きい方で判定
 *   (はみ出して描画される表との重なりも検知する・@codex #310)。ただし
 *   borderless(消費者向けひな型)の表は外側の <div> の overflow:hidden で
 *   実際に切り取られるため、保存された箱 {x,y,w,h} をそのまま使う(F1)。
 */
export function findTextTableOverlaps(
  document: SalesSheetDocument,
): TextTableOverlapPair[] {
  // ASCII の字送りモデルはフォントで変える (mono=均一0.6em / プロポーショナル=
  // 段階化)。text は要素指定フォント優先・表はテーマ。
  const themeMono = isMonospaceFamily(document.theme.fontFamily);
  const entries = document.elements
    .filter(
      (e): e is TextElement | TableElement =>
        (e.type === "text" &&
          e.content.trim() !== "" &&
          // 完全透明の文字色は描画されない (@codex #310 R35。表は罫線が
          // 残るため対象のまま)
          !isFullyTransparentColor(e.style.color)) ||
        (e.type === "table" && e.rows.length > 0),
    )
    .map((e) =>
      e.type === "text"
        ? {
            id: e.id,
            rects: textRenderedLineRectsMm(
              e,
              isMonospaceFamily(e.style.fontFamily ?? document.theme.fontFamily),
            ),
          }
        : {
            id: e.id,
            // borderless(消費者向けひな型の主要表/詳細表): 外側の <div> が
            // overflow:hidden で実際に描画を切り取るため、保存された箱
            // {x,y,w,h} を超えて重なることは無い(F1)。非 borderless(旧
            // ひな型)の <table> は箱に切り取られず、行数や折返しで保存 h/w を
            // 超えて描画されるため、従来どおり見積りで育てた矩形を使う。
            rects: e.style.borderless
              ? [{ x: e.x, y: e.y, w: e.w, h: e.h }]
              : [
                  {
                    x: e.x,
                    y: e.y,
                    // セルの折返し不可な長い値は表の右へはみ出して描画される
                    // (@codex #310 R23: overflow hidden は table box に効かない)
                    w: estimatedTableWidthMm(e, themeMono, document.page.width),
                    h: Math.max(
                      e.h,
                      estimatedTableHeightMm(e, themeMono, document.page.height),
                    ),
                  },
                ],
          },
    );
  const rectsOverlap = (a: RectMm, b: RectMm): boolean => {
    const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return overlapW > OVERLAP_TOLERANCE_MM && overlapH > OVERLAP_TOLERANCE_MM;
  };
  const pairs: TextTableOverlapPair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.rects.some((ra) => b.rects.some((rb) => rectsOverlap(ra, rb)))) {
        pairs.push({ aId: a.id, bId: b.id });
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// B-8 案A (2026-08-23 発注者判断で採用): 重なりの自動解消 (ボタンで実行)
// ---------------------------------------------------------------------------

/** resolveTextTableOverlapsInDocument の結果。 */
export interface ResolveOverlapsResult {
  /** 調整後の document (何も変えなければ入力と同一参照)。 */
  document: SalesSheetDocument;
  /** 文字サイズの縮小で解消した要素 id (document 順)。 */
  shrunk: string[];
  /** 位置の移動で解消した要素 id (document 順)。 */
  moved: string[];
  /** 自動では解消できず残った重なりの組数 (表×表を含む)。 */
  unresolved: number;
}

/** 縮小の刻み (pt)。 */
const SHRINK_STEP_PT = 0.5;
/** 縮小の下限 = 元サイズ×この比率 (それ未満には読めないので下げない)。 */
const SHRINK_FLOOR_RATIO = 0.6;
/** 縮小の絶対下限 (pt)。 */
const SHRINK_FLOOR_PT = 7;
/** 移動の探索刻み (mm)。 */
const MOVE_STEP_MM = 1;
/** 移動の探索上限 (mm)。これ以上遠くへは動かさない (置き場所の意図を壊さない)。 */
const MOVE_MAX_MM = 60;
/**
 * 縮小の試行回数の上限 (@codex #403 R1 P1)。schema は fontSizePt に上限を
 * 持たないため、巨大な値 (例 1e20) では `pt -= 0.5` が IEEE-754 で**変化せず**、
 * 添字を pt にした while/for は**無限ループ=ブラウザのタブが固まる**。
 * 整数カウンタで回し、かつ回数そのものにも蓋をする (200回=100pt ぶん。
 * 実用のフォントサイズなら十分・巨大値でも一瞬で諦めて移動へ進む)。
 */
const SHRINK_MAX_STEPS = 200;

/** id の要素が関与する重なりが有るか。 */
function hasOverlapInvolving(doc: SalesSheetDocument, id: string): boolean {
  return findTextTableOverlaps(doc).some((p) => p.aId === id || p.bId === id);
}

/**
 * この text 要素を**この要素側で**直すべきか。
 * - 表との重なり: 常にこちら(text)が動く (表は動かさない)。
 * - 文字×文字: **後から置いた方**(document 順で後)が動く。先にあった要素は
 *   置き場所の基準として尊重する (両方を動かすと、どちらも半端に動く)。
 */
function needsFixHere(doc: SalesSheetDocument, idx: number): boolean {
  const id = doc.elements[idx].id;
  const indexOf = new Map(doc.elements.map((e, i) => [e.id, i] as const));
  const typeOf = new Map(doc.elements.map((e) => [e.id, e.type] as const));
  return findTextTableOverlaps(doc).some((p) => {
    const partner = p.aId === id ? p.bId : p.bId === id ? p.aId : null;
    if (partner === null) return false;
    if (typeOf.get(partner) === "table") return true;
    return (indexOf.get(partner) ?? -1) < idx;
  });
}

/** elements[idx] を差し替えた新 document。 */
function withElementAt(
  doc: SalesSheetDocument,
  idx: number,
  el: SalesSheetElement,
): SalesSheetDocument {
  const elements = doc.elements.slice();
  elements[idx] = el;
  return { ...doc, elements };
}

/**
 * 文字・表の重なりを「縮小 → 駄目なら移動」で自動解消する (純関数)。
 *
 * ⚠**勝手には動かさない**。この関数は利用者が「重なりを自動で直す」ボタンを
 *   押したときにだけ呼ばれる (案Aが見送られていた理由=「手動配置の尊重」との
 *   相反を、明示操作に限ることで両立させた・2026-08-23 発注者判断)。
 *
 * 規則:
 * - 調整するのは **text だけ**。表は動かさない (表×表の重なりは unresolved)。
 * - 各 text につき ①縮小 (SHRINK_STEP_PT 刻み・下限=元の6割か7ptの大きい方)
 *   ②縦の最小距離移動 (±MOVE_STEP_MM 刻み・ページ内・**新たな重なりを作らない**
 *   =候補ごとに検知器そのもので再判定) の順に試す。
 * - x は変えない (縦の最小移動だけなら「どこへ行ったか」を利用者が追える)。
 * - 解消できない要素は**触らない** (中途半端な縮小だけ残さない)。
 * - document 順に処理し、後続の判定は調整後の document で行う (決定的)。
 * - 何も変えなければ入力と**同一参照**を返す (no-op 規約)。
 */
export function resolveTextTableOverlapsInDocument(
  doc: SalesSheetDocument,
): ResolveOverlapsResult {
  const shrunk: string[] = [];
  const moved: string[] = [];
  let current = doc;

  for (let idx = 0; idx < current.elements.length; idx++) {
    const el = current.elements[idx];
    if (el.type !== "text") continue;
    if (!needsFixHere(current, idx)) continue;

    // ① 縮小 (位置は不変)。効果は検知器そのもので測る (字送り・折返し・
    //    可視行の打ち切りまで含めた本物のモデルで再判定する)。
    const originalPt = el.style.fontSizePt ?? 12;
    const floorPt = Math.max(SHRINK_FLOOR_PT, originalPt * SHRINK_FLOOR_RATIO);
    let fixed = false;
    // ⚠添字は**整数カウンタ** (@codex #403 R1 P1: pt 自体を減算すると巨大値で
    //   浮動小数が変化せず無限ループになる)。回数にも SHRINK_MAX_STEPS の蓋。
    for (let step = 1; step <= SHRINK_MAX_STEPS; step++) {
      const pt = originalPt - step * SHRINK_STEP_PT;
      if (pt < floorPt - 1e-9) break;
      const rounded = Math.round(pt * 2) / 2;
      if (rounded >= originalPt) break; // 巨大値で丸めが効かない場合も前へ進める
      const candidate = withElementAt(current, idx, {
        ...el,
        style: { ...el.style, fontSizePt: rounded },
      });
      if (!hasOverlapInvolving(candidate, el.id)) {
        current = candidate;
        shrunk.push(el.id);
        fixed = true;
        break;
      }
    }
    if (fixed) continue;

    // ② 縦の最小距離移動。近い順 (+1, -1, +2, -2, …) に試し、ページ内かつ
    //    自分の重なりが消える最初の位置を採る。
    for (let step = MOVE_STEP_MM; step <= MOVE_MAX_MM; step += MOVE_STEP_MM) {
      let done = false;
      for (const dy of [step, -step]) {
        const y = el.y + dy;
        if (y < 0 || y + el.h > current.page.height) continue;
        const candidate = withElementAt(current, idx, { ...el, y });
        if (!hasOverlapInvolving(candidate, el.id)) {
          current = candidate;
          moved.push(el.id);
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }

  return {
    document: current,
    shrunk,
    moved,
    unresolved: findTextTableOverlaps(current).length,
  };
}

/**
 * EditorState 版 (履歴に乗せるための入口)。何も変わらなければ同一参照。
 * dirty は document が変わったときだけ立てる (既存の編集系と同じ規約)。
 */
export function resolveOverlapsInState(state: EditorState): EditorState {
  const r = resolveTextTableOverlapsInDocument(state.document);
  if (r.document === state.document) return state;
  return { ...state, document: r.document, dirty: true };
}
