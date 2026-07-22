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
  computeSpecSheetLayout,
  DEFAULT_FOOTER_H,
  MAIN_BOTTOM_MARGIN_MM,
  SALES_POINTS_H_MM,
  PHOTO_GAP_MM,
  PHOTO_AREA_TO_OVERVIEW_GAP_MM,
  COLUMN_GAP_MM,
} from "./layout-engine";
import { packMosaic } from "./mosaic-pack";
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

/** 地図QR(物件の場所の Google マップ QR)の固定 id。中央列の間取図と同じく1枚のみ。 */
export const MAP_QR_ID = "map-qr";
/** QR と直上の間取図の間の余白(mm)。 */
const MAP_QR_GAP_MM = 4;
/** 間取図/写真ゾーンから予約する QR の高さ(mm)。QR は後でリサイズ可能だが、予約量は既定サイズ
 *  固定にする＝ユーザーが QR をリサイズしても予約(図の縮み/写真帯)や削除時の復元判定がずれない
 *  (@codex #300)。 */
const MAP_QR_RESERVE_H_MM = DEFAULT_QR_SIZE_MM;

/**
 * 地図QR(id="map-qr")の位置を版面に合わせて整える(@codex #300):
 * - floor-plan があれば、その真下・会社帯の上に収まるよう図を縮め/上へ寄せ、QR を図の下・
 *   幅内中央へ。QR は会社帯/セールスポイントの上端(contentBottom)より下へは出さない。
 * - floor-plan が無ければ、図面の右下(会社帯の上)へ戻す(図を削除/解除したら写真が中央へ
 *   広がるため、QR をその場に残さずフォールバック位置へ)。
 * - map-qr が無ければ同一参照。追加/図の指定・解除・削除・リサイズ・レイアウト自動調整の
 *   各経路の末尾で呼び、位置を一貫させる。
 */
function positionMapQr(
  elements: SalesSheetElement[],
  page: { width: number; height: number },
): SalesSheetElement[] {
  const qrIdx = elements.findIndex((e) => e.id === MAP_QR_ID && e.type === "qr");
  if (qrIdx === -1) return elements;
  const qr = elements[qrIdx];
  const contentBottom = page.height - PHOTO_ZONE_BOTTOM_MARGIN_MM;
  const fpIdx = elements.findIndex((e) => e.id === "floor-plan" && e.type === "image");
  if (fpIdx === -1) {
    // 図なし → 右下(会社帯の上)フォールバック。
    // 概要表(右1/3)を避けるため、その左端の手前・会社帯の上に置く(右端ぴったりだと
    // 概要表のセルを覆う・@codex #300 P1)。概要表の実位置(無ければ定位置)を基準にする。
    const overviewEl = elements.find((e) => e.id === "overview");
    const ovLeft = overviewEl
      ? overviewEl.x
      : page.width - PHOTO_ZONE_X_MM - page.width / 3;
    const qrX = clamp(ovLeft - COLUMN_GAP_MM - qr.w, 0, Math.max(0, page.width - qr.w));
    const qrY = clamp(contentBottom - qr.h, 0, Math.max(0, page.height - qr.h));
    if (nearlyEqual(qrX, qr.x) && nearlyEqual(qrY, qr.y)) return elements;
    const next = elements.slice();
    next[qrIdx] = applyGeom(qr, { x: qrX, y: qrY });
    return next;
  }
  const fp = elements[fpIdx];
  // 予約量は固定(MAP_QR_RESERVE_H_MM)＝ユーザーが QR をリサイズしても図の縮み量が変わらない。
  // 図(最小高)+ gap + 予約 が contentBottom 内に収まる図の最大 y。図を会社帯へ近づけ過ぎると
  // 下に空きが作れず QR が図の上へ回り込むため、その場合は図を上へ寄せる(@codex #300)。
  const maxFloorY = Math.max(0, contentBottom - MIN_ELEMENT_SIZE_MM - MAP_QR_GAP_MM - MAP_QR_RESERVE_H_MM);
  const fpY = Math.min(fp.y, maxFloorY);
  // 図の下に QR(gap+予約高さ)を収めるための図の最大下端。下端いっぱいなら縮める。
  const maxFloorBottom = contentBottom - MAP_QR_GAP_MM - MAP_QR_RESERVE_H_MM;
  const newFpH =
    fpY + fp.h > maxFloorBottom
      ? Math.max(MIN_ELEMENT_SIZE_MM, maxFloorBottom - fpY)
      : fp.h;
  // 図が QR より細い(commitFloorPlanGeometry は図を MIN_ELEMENT_SIZE_MM まで許容)場合、
  // QR を図の列幅に収める(縮小時は正方形を保ちスキャン性を維持・@codex #300)。写真域/概要表へ
  // はみ出さないよう横幅も制約する。
  const fits = qr.w <= fp.w;
  const qrW = fits ? qr.w : fp.w;
  const qrH = fits ? qr.h : fp.w;
  const qrX = clamp(fp.x + (fp.w - qrW) / 2, 0, Math.max(0, page.width - qrW));
  // 会社帯の上(contentBottom − h)を上限にクランプ。図の y を上へ寄せた分、QR は必ず図の真下。
  const qrY = clamp(fpY + newFpH + MAP_QR_GAP_MM, 0, Math.max(0, contentBottom - qrH));
  const fpChanged = !nearlyEqual(fpY, fp.y) || !nearlyEqual(newFpH, fp.h);
  const qrChanged =
    !nearlyEqual(qrX, qr.x) ||
    !nearlyEqual(qrY, qr.y) ||
    !nearlyEqual(qrW, qr.w) ||
    !nearlyEqual(qrH, qr.h);
  if (!fpChanged && !qrChanged) return elements;
  const next = elements.slice();
  if (fpChanged) next[fpIdx] = applyGeom(fp, { y: fpY, h: newFpH });
  next[qrIdx] = applyGeom(qr, { x: qrX, y: qrY, w: qrW, h: qrH });
  return next;
}

/** state に地図QRの位置調整(positionMapQr)を適用。変更なしは同一参照。
 *  間取図の配置/差替え/リサイズ/解除/削除の各経路の末尾で呼び、地図QRの位置を保つ。 */
export function positionMapQrInState(state: EditorState): EditorState {
  const reserved = positionMapQr(state.document.elements, state.document.page);
  if (reserved === state.document.elements) return state;
  return { ...state, dirty: true, document: { ...state.document, elements: reserved } };
}

/**
 * 物件の住所から Google マップ検索の QR を作り、間取図(中央列)の下に差し込む。
 * - 住所が空 / URL 生成不能 / QR 生成不能なら no-op(同一参照)。
 * - 地図QR は id="map-qr" の1枚(既存があれば置き換え)。floor-plan があればその真下・図の幅内で
 *   中央寄せ(図を縮めて会社帯を覆わない・positionMapQr)、無ければ図面の右下
 *   (会社帯の上)。用紙内クランプ・z=最前面・自動選択・dirty。
 * - QR の中身(content)= Maps URL。後からパネルで移動/リサイズ/内容編集も可(通常の qr 要素)。
 */
export function addMapQrElement(
  state: EditorState,
  params: { address: string; aspects?: Record<string, number> },
): EditorState {
  const url = buildMapsSearchUrl(params.address);
  if (url === null) return state;
  const dataUrl = generateQrDataUrl(url);
  if (dataUrl === null) return state;
  const { document } = state;
  const { page } = document;
  const w = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_QR_SIZE_MM, page.width - 10));
  const h = Math.max(MIN_ELEMENT_SIZE_MM, Math.min(DEFAULT_QR_SIZE_MM, page.height - 10));
  const contentBottom = page.height - PHOTO_ZONE_BOTTOM_MARGIN_MM;

  // 地図QR は1枚に(既存を置き換え)。
  const base = document.elements.filter((e) => e.id !== MAP_QR_ID);
  const floorPlanEl = base.find((e) => e.id === "floor-plan" && e.type === "image");
  // 初期位置: 図ありは仮に真下(この後 reserve で確定)、図なしは右下・会社帯の上。
  let x: number;
  let y: number;
  if (floorPlanEl) {
    x = floorPlanEl.x + (floorPlanEl.w - w) / 2;
    y = floorPlanEl.y + floorPlanEl.h + MAP_QR_GAP_MM;
  } else {
    x = page.width - w - 10;
    y = contentBottom - h;
  }
  x = clamp(x, 0, Math.max(0, page.width - w));
  y = clamp(y, 0, Math.max(0, contentBottom - h));
  const z = base.length ? Math.max(...base.map((e) => e.z)) + 1 : 1;
  const mapQrEl: QrElement = {
    id: MAP_QR_ID,
    type: "qr",
    x,
    y,
    w,
    h,
    z,
    dataUrl,
    content: url,
  };
  const withQr: EditorState = {
    ...state,
    dirty: true,
    selectedId: MAP_QR_ID,
    document: { ...document, elements: [...base, mapQrEl] },
  };
  // 先に autoArrangePhotos(概要表を定位置へスナップ・写真帯を予約・写真を再整列)を行い、
  // その後に positionMapQr で QR を最終レイアウト(スナップ後の概要表/図)基準で置く。順序を
  // 逆にすると QR が旧概要表位置基準になりスナップ後にずれる(@codex #300)。
  const arranged = autoArrangePhotos(withQr, params.aspects ? { aspects: params.aspects } : undefined);
  return positionMapQrInState(arranged);
}

/**
 * 地図QR(map-qr)を削除し、QR の予約のために縮めた間取図の高さを解放する(@codex #300)。
 * - map-qr が無ければ no-op。floor-plan が無ければ削除のみ。
 * - **予約境界にちょうど収まっている図だけ**を全高(会社帯の上端=contentBottom まで)へ戻す。
 *   手動で別の高さにした図(予約境界と一致しない)は尊重してそのまま(@codex #300: 高さ保持)。
 */
export function deleteMapQr(
  state: EditorState,
  aspects?: Record<string, number>,
): EditorState {
  if (!state.document.elements.some((e) => e.id === MAP_QR_ID && e.type === "qr")) return state;
  const removed = deleteElement(state, MAP_QR_ID);
  const { document } = removed;
  const { page } = document;
  const contentBottom = page.height - PHOTO_ZONE_BOTTOM_MARGIN_MM;
  const fpIdx = document.elements.findIndex((e) => e.id === "floor-plan" && e.type === "image");
  let released = removed;
  if (fpIdx !== -1) {
    const fp = document.elements[fpIdx];
    // 予約時の図の下端(固定予約量ベース=QR をリサイズしても不変)にちょうど一致する図だけ、
    // 全高へ戻して空白を解消。手動で別の高さにした図は尊重する(@codex #300)。
    const reservedBottom = contentBottom - MAP_QR_GAP_MM - MAP_QR_RESERVE_H_MM;
    const fullH = Math.max(MIN_ELEMENT_SIZE_MM, contentBottom - fp.y);
    if (nearlyEqual(fp.y + fp.h, reservedBottom) && !nearlyEqual(fp.h, fullH)) {
      const elements = document.elements.slice();
      elements[fpIdx] = applyGeom(fp, { h: fullH });
      released = { ...removed, dirty: true, document: { ...document, elements } };
    }
  }
  // QR が消え予約が解けたので写真を再整列する(図なしで縮めていた写真ゾーンを全高へ広げる・
  // 図ありでも変化ゼロなら同一参照・@codex #300)。
  return autoArrangePhotos(released, aspects ? { aspects } : undefined);
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

/**
 * buildSpecSheetDocument が組む既知のテンプレ要素 id。これらの id を持つ要素は
 * 「テンプレ枠」として扱う（type==="image" 判定より優先）。floor-plan は type="image"
 * だが、この集合に含めることで写真ゾーン（写真スロット）ではなく専用の間取り図枠で
 * 扱い、autoArrangePhotos の整列対象・autoBalanceLayout の写真カウントに混入させない。
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

/** 写真ゾーン: テンプレの左カラム（タイトル/価格帯の下・概要表の左・会社帯の上）。 */
const PHOTO_ZONE_X_MM = 10;
const PHOTO_ZONE_Y_MM = 46;
/** overview 要素が無い素の版面での写真ゾーン右境界＝ページ幅の 2/3（要件⑤の思想）。 */
const PHOTO_ZONE_FALLBACK_RATIO = 2 / 3;
// 写真ゾーン下端を、エンジンが写真敷詰めを止める位置（photoPackBottom = mainBottom −
// salesPoints帯 − gap）に合わせる（@codex R1/R2）。会社帯だけでなく salesPoints 帯も避け、
// 作成/再バランス経路と同じ予約にする。page 下端からの余白＝帯高 + main下余白 + salesPoints高 + gap。
const PHOTO_ZONE_BOTTOM_MARGIN_MM =
  DEFAULT_FOOTER_H + MAIN_BOTTOM_MARGIN_MM + SALES_POINTS_H_MM + PHOTO_GAP_MM;

/**
 * すべてのギャラリー写真を写真ゾーンへ「モザイク配置」で整列し直す
 * （ワンボタン自動レイアウト／写真追加時にも自動実行）。
 * - 対象はギャラリー写真のみ。テンプレ枠(TEMPLATE_ELEMENT_IDS・floor-plan含む)は不動。
 * - 写真ゾーンは**常に左2/3固定**: 右端 = OVERVIEW_MIN_X_MM(188) − 水平余白(11) = 177。
 *   overview 要素が無い自由版面のみページ幅の2/3を右境界にする。
 * - **overview(物件種目の枠)は定位置へスナップ**: 左端が定位置(188)からずれていれば
 *   x=188 / 右端=287 に寄せる(y/h維持)＝古い図面でも「最初からその位置」でレイアウト。
 * - 並び順=呼び出し時点の**見た目の順**(上の行から左→右)。opts.appendedId は末尾。
 * - 枠は各写真の実寸縦横比(opts.aspects[id]・無ければ現枠のw/h比)を保ったまま、
 *   スライシング木の全列挙で最も無駄の少ない配置を選ぶ(packMosaic・写真ごとに大小差が付く)。
 *   縦長2枚+横長1枚のような組合せでも「細い1列」に潰れず左2/3を使い切る。切り取りなし。
 * - fit:"contain"(枠比=写真比のため見た目は全面表示)。src/焦点/角丸/alt/z は保存。
 * - 純・決定的。変更ゼロなら同一参照(no-op)。変更があれば dirty=true。
 */
export function autoArrangePhotos(
  state: EditorState,
  opts?: { appendedId?: string; aspects?: Record<string, number> },
): EditorState {
  const { document } = state;
  const { page } = document;
  // 対象はギャラリー写真のみ。間取り図など既知のテンプレ枠（floor-plan は type=image）は
  // 専用枠に留めるため整列対象から除外する（autoBalanceLayout と同じ扱い）。
  const targets: number[] = [];
  document.elements.forEach((e, i) => {
    if (e.type === "image" && !TEMPLATE_ELEMENT_IDS.has(e.id)) targets.push(i);
  });
  if (targets.length === 0) return state;

  // overview(物件種目の枠)は定位置(右1/3)へスナップ。写真ゾーンは常に左側固定。
  // 定位置はページ幅から相対計算する(A4横なら x=188/右端287 で従来定数と一致)。
  // 固定定数だと A4縦(幅210)で右端287を書き込み用紙外→保存不能になる(@codex #294 R5)。
  const ovRight = page.width - PHOTO_ZONE_X_MM;
  const ovMinX = ovRight - page.width / 3;
  const overviewIdx = document.elements.findIndex((e) => e.id === "overview");
  const overviewEl = overviewIdx >= 0 ? document.elements[overviewIdx] : null;
  const boundaryX = overviewEl ? ovMinX : page.width * PHOTO_ZONE_FALLBACK_RATIO;
  const overviewNeedsSnap =
    overviewEl !== null &&
    (!nearlyEqual(overviewEl.x, ovMinX) || !nearlyEqual(overviewEl.w, ovRight - ovMinX));

  // 間取り図/敷地図(floor-plan)は 3列構成の「中央列」。写真ゾーンはその左に置く＝
  // 写真ゾーン右端 = 図の左端 − COLUMN_GAP（図があるとき）。図を広げる(左端を左へ動かす)と
  // 写真ゾーンが反比例で狭くなる。図が無ければ従来どおり overview 左（or 2/3）まで。
  // 図は横に並ぶので写真は上端から敷く（図の下へ寄せない）。
  const floorPlanEl = document.elements.find((e) => e.id === "floor-plan" && e.type === "image");
  const zoneX = PHOTO_ZONE_X_MM;
  const zoneY = PHOTO_ZONE_Y_MM;
  const overviewBoundaryRight = boundaryX - PHOTO_AREA_TO_OVERVIEW_GAP_MM;
  const zoneRight = floorPlanEl
    ? Math.min(overviewBoundaryRight, floorPlanEl.x - COLUMN_GAP_MM)
    : overviewBoundaryRight;
  const zoneW = Math.max(0, zoneRight - zoneX);
  // 図が無く地図QRがある場合は、写真ゾーン下端を QR(高さ+gap)分だけ上げて予約する
  // (QR は positionMapQr がその下帯・概要表の左へ置く=写真と重ならない・@codex #300 P1)。
  // 図がある場合は floor-plan 側の予約で処理するのでここでは不要。
  const mapQrEl = document.elements.find((e) => e.id === MAP_QR_ID && e.type === "qr");
  const mapQrBand = !floorPlanEl && mapQrEl ? MAP_QR_RESERVE_H_MM + COLUMN_GAP_MM : 0;
  const zoneH = Math.max(0, page.height - zoneY - PHOTO_ZONE_BOTTOM_MARGIN_MM - mapQrBand);
  // ゾーンが最小要素サイズ未満に潰れている(例: 間取り図を縦に大きくリサイズ)場合は
  // 整列しない=非正/極小寸法を document に書き込まない(書き込むと schema の positive
  // 検証で保存不能になる・提出前レビュー指摘)。
  if (zoneW < MIN_ELEMENT_SIZE_MM || zoneH < MIN_ELEMENT_SIZE_MM) return state;

  // 並び順=ドキュメント配列順(=写真の追加順・代表写真が先頭)。
  // モザイク配置(packMosaic)は行構造でない(右に縦長1列など)ため、位置から読み順を
  // 再導出すると再適用で順序が入れ替わり冪等性が壊れる。配列順は整列間で不変(整列は
  // elements[idx] を in-place 置換し配列順を変えない)なので、これを読み順にすることで
  // 「整列済みへの再適用=no-op」を構造的に保証する。写真は append 追加なので配列順=追加順。
  const ordered = targets.slice();
  if (opts?.appendedId) {
    const k = ordered.findIndex((idx) => document.elements[idx].id === opts.appendedId);
    if (k >= 0) ordered.push(...ordered.splice(k, 1));
  }

  // 各写真の縦横比: 実測値(opts.aspects)優先・無ければ現枠の w/h(非正は justified 側が矯正)。
  const aspects = ordered.map((idx) => {
    const el = document.elements[idx];
    return opts?.aspects?.[el.id] ?? (el.h > 0 ? el.w / el.h : 0);
  });
  const rects = packMosaic(aspects, zoneW, zoneH, PHOTO_GAP_MM);

  let changed = false;
  const elements = document.elements.slice() as SalesSheetElement[];
  ordered.forEach((idx, k) => {
    const el = elements[idx] as ImageElement;
    const r = rects[k];
    const x = zoneX + r.x;
    const y = zoneY + r.y;
    // 幾何は 1/1000mm 単位で比較(浮動小数の等値比較で毎回 dirty 化しない・冪等)。
    if (
      !nearlyEqual(el.x, x) ||
      !nearlyEqual(el.y, y) ||
      !nearlyEqual(el.w, r.w) ||
      !nearlyEqual(el.h, r.h) ||
      el.fit !== "contain"
    ) {
      changed = true;
      elements[idx] = { ...el, x, y, w: r.w, h: r.h, fit: "contain" };
    }
  });
  if (overviewNeedsSnap && overviewEl) {
    changed = true;
    elements[overviewIdx] = applyGeom(overviewEl, { x: ovMinX, w: ovRight - ovMinX });
  }
  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements } };
}

/** 幾何座標の等値判定(1/1000mm 許容・整列の冪等性用)。 */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/**
 * 中央列(間取り図/敷地図)の既定 rect をページ寸法から算出する。
 * 版面を概ね三等分し、中央列の右端は概要表の左に近接、左端は写真域と半々。
 * 実編集ではユーザーが幅をドラッグで調整し、写真は残りスペースへ詰め直される。
 */
function defaultFloorPlanRect(page: { width: number; height: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const ovRight = page.width - PHOTO_ZONE_X_MM;
  const ovMinX = ovRight - page.width / 3;
  const floorPlanRight = ovMinX - COLUMN_GAP_MM;
  const leftRegionW = floorPlanRight - PHOTO_ZONE_X_MM; // 写真域+中央列の合計幅
  const w = Math.max(MIN_ELEMENT_SIZE_MM, (leftRegionW - COLUMN_GAP_MM) / 2);
  const x = floorPlanRight - w;
  const y = PHOTO_ZONE_Y_MM;
  const h = Math.max(MIN_ELEMENT_SIZE_MM, page.height - PHOTO_ZONE_BOTTOM_MARGIN_MM - PHOTO_ZONE_Y_MM);
  return { x, y, w, h };
}

/**
 * overview(概要表)を定位置(右1/3)へスナップする(破壊的に elements を書き換え)。
 * autoArrangePhotos も同じスナップを行うが、写真0枚だと同関数が対象0で早期 return し
 * スナップ前に抜けるため、floor-plan 操作側でも概要表の定位置を保証する(@codex #298)。
 * 変更があれば true。elements は呼び出し側で slice 済みの前提。
 */
function snapOverviewInPlace(
  elements: SalesSheetElement[],
  page: { width: number; height: number },
): boolean {
  const idx = elements.findIndex((e) => e.id === "overview");
  if (idx === -1) return false;
  const ov = elements[idx];
  const ovRight = page.width - PHOTO_ZONE_X_MM;
  const ovMinX = ovRight - page.width / 3;
  if (nearlyEqual(ov.x, ovMinX) && nearlyEqual(ov.w, ovRight - ovMinX)) return false;
  elements[idx] = applyGeom(ov, { x: ovMinX, w: ovRight - ovMinX });
  return true;
}

/**
 * 選択中の写真を中央列の「間取り図/敷地図」(id="floor-plan")にする。
 * - 対象は image かつ id!=="floor-plan"。それ以外は no-op(同一参照)。
 * - 既存の floor-plan があれば demotedId へ改名して写真へ降格(中央は常に1枚)。
 * - 対象を id="floor-plan"・fit:"contain"・中央列の既定 rect へ。
 * - 続けて autoArrangePhotos で写真を図の左へ詰め直す。selectedId は "floor-plan" に。
 * - id はサーバでなく呼び出し側が safeRandomId で用意する(reducer は純・決定的)。
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
  if (existingIdx !== -1) {
    // 既存の間取り図を写真へ降格(id を付け替え・幾何/内容は保持=整列で再配置される)。
    elements[existingIdx] = { ...elements[existingIdx], id: demotedId } as SalesSheetElement;
  }
  const rect = defaultFloorPlanRect(document.page);
  elements[idx] = {
    ...(target as ImageElement),
    id: "floor-plan",
    fit: "contain",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  };
  // 写真が0枚(この1枚を図にした)だと autoArrangePhotos が overview スナップ前に return する
  // ため、ここで概要表を定位置へ寄せて中央列との重なりを防ぐ(@codex #298)。
  snapOverviewInPlace(elements, document.page);
  const next: EditorState = {
    ...state,
    dirty: true,
    selectedId: "floor-plan",
    document: { ...document, elements },
  };
  // 写真を図の左へモザイクで詰め直し、地図QRがあれば新しい図の真下へ再確保する(@codex #300)。
  return positionMapQrInState(autoArrangePhotos(next, aspects ? { aspects } : undefined));
}

/**
 * 中央列の「間取り図/敷地図」(id="floor-plan")を通常の写真へ戻す(解除)。
 * - floor-plan が無ければ no-op。id を newId へ改名して写真化 → autoArrangePhotos で整列。
 * - selectedId は newId に。id は呼び出し側が safeRandomId で用意。
 */
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
  const next: EditorState = {
    ...state,
    dirty: true,
    selectedId: newId,
    document: { ...document, elements },
  };
  // 図を解除したら写真が中央へ広がるため、地図QRを右下フォールバックへ戻す(@codex #300)。
  return positionMapQrInState(autoArrangePhotos(next, aspects ? { aspects } : undefined));
}

/**
 * 中央列(間取り図/敷地図=floor-plan)の move/resize を確定し、右端を概要表の左へアンカー
 * したうえで写真を再整列する。**幾何確定と写真リフローを1回の更新で行う**(=undo 1回で
 * リサイズ全体が戻る・@codex #298)。
 * - mode="resize": 右端を anchorRight に固定＝どの向きのハンドルで広げても左端が動く→写真が
 *   反比例で狭まる。概要表への食い込みも起きない(@codex #298 の右ハンドル問題を解消)。
 * - mode="move": 右端が概要表を越えない範囲で自由移動(左へ動かすと写真が狭まる)。縦は自由。
 * - floor-plan が無ければ no-op。写真ゾーンが最小要素サイズ未満に潰れない幅にクランプ。
 */
export function commitFloorPlanGeometry(
  state: EditorState,
  geom: { mode: "resize" | "move"; x?: number; y?: number; w?: number; h?: number },
  aspects?: Record<string, number>,
): EditorState {
  const { document } = state;
  const { page } = document;
  const idx = document.elements.findIndex((e) => e.id === "floor-plan" && e.type === "image");
  if (idx === -1) return state;
  const fp = document.elements[idx];

  const overviewEl = document.elements.find((e) => e.id === "overview");
  const ovRight = page.width - PHOTO_ZONE_X_MM;
  const ovMinX = ovRight - page.width / 3;
  const boundaryX = overviewEl ? ovMinX : page.width * PHOTO_ZONE_FALLBACK_RATIO;
  const anchorRight = boundaryX - COLUMN_GAP_MM; // 図の右端(概要表の左に近接)
  // 図の左端の下限＝写真域が最小要素サイズ分は残る位置。
  const minX = PHOTO_ZONE_X_MM + MIN_ELEMENT_SIZE_MM + COLUMN_GAP_MM;
  const maxW = Math.max(MIN_ELEMENT_SIZE_MM, anchorRight - minX);

  const w = clamp(geom.w ?? fp.w, MIN_ELEMENT_SIZE_MM, maxW);
  const y = clamp(geom.y ?? fp.y, 0, Math.max(0, page.height - MIN_ELEMENT_SIZE_MM));
  const h = clamp(geom.h ?? fp.h, MIN_ELEMENT_SIZE_MM, Math.max(MIN_ELEMENT_SIZE_MM, page.height - y));
  const x =
    geom.mode === "resize"
      ? Math.max(0, anchorRight - w) // 右端アンカー
      : // move も左端の下限は minX(写真域が最小サイズ分残る位置)。PHOTO_ZONE_X_MM まで許すと
        // 写真ゾーンが潰れ autoArrangePhotos が写真を動かせず図が写真に重なる(@codex #298 P1)。
        clamp(geom.x ?? fp.x, minX, Math.max(minX, anchorRight - w));

  const fpChanged =
    !nearlyEqual(x, fp.x) || !nearlyEqual(y, fp.y) || !nearlyEqual(w, fp.w) || !nearlyEqual(h, fp.h);
  let elements = document.elements;
  if (fpChanged) {
    elements = document.elements.slice();
    elements[idx] = applyGeom(fp, { x, y, w, h });
  }
  // 概要表を定位置へ(写真0枚だと autoArrangePhotos がスナップ前に return するため・@codex #298)。
  if (elements === document.elements) {
    const copy = document.elements.slice();
    if (snapOverviewInPlace(copy, page)) elements = copy;
  } else {
    snapOverviewInPlace(elements, page);
  }
  const moved: EditorState =
    elements === document.elements
      ? state
      : { ...state, dirty: true, document: { ...document, elements } };
  // 写真を図の左へ詰め直し、地図QRがあれば図の真下へ再確保する(リサイズ/移動に追従・@codex #300)。
  return positionMapQrInState(autoArrangePhotos(moved, aspects ? { aspects } : undefined));
}

// ---------------------------------------------------------------------------
// レイアウト自動再バランス（写真枚数/概要表行数/間取り有無に応じて、テンプレ枠と写真を
// computeSpecSheetLayout の算出値へ再配置するワンボタン操作）。
// ---------------------------------------------------------------------------


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

  // 地図QR(id="map-qr")がある場合、全高に戻した間取図が QR を覆わないよう、図を縮めて
  // QR を真下へ再確保する(@codex #300: 追加時の予約を自動調整でも保つ)。
  const reserved = positionMapQr(next, document.page);
  if (reserved !== next) changed = true;

  if (!changed) return state;
  return { ...state, dirty: true, document: { ...document, elements: reserved } };
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
 * レンダラ (SalesSheetRenderer / render-html) は <table> を直接絶対配置する
 * ため、CSS の height は最小値扱いで、行数の増加やセル内の折返しで保存 h を
 * 超えて描画される (overflow:hidden は table 要素の行を切り取らない・@codex #310)。
 * 行ごとに「セル幅(label 32% / value 68%)に収まらない分の折返し行数」を
 * 全角=フォント幅 1 文字分として概算する (厳密なテキスト実測はしない)。
 */
function estimatedTableHeightMm(
  el: TableElement,
  mono: boolean,
  maxHeightMm: number,
): number {
  // fontSizePt 未指定時、両レンダラは font-size を出力せずブラウザ既定の
  // 16px = 12pt を継承する (@codex #310 R3: 9pt と仮定すると過小見積りになる)。
  const fontMm = (el.style.fontSizePt ?? 12) * PT_TO_MM;
  const lineMm = fontMm * 1.3;
  // 左右 padding 1mm×2 相当を引いたセル幅。極端に狭い表でも 1 文字分は確保。
  const labelW = Math.max(el.w * 0.32 - 2, fontMm);
  const valueW = Math.max(el.w * 0.68 - 2, fontMm);
  // 行容量 (em) は端数を保つ (@codex #310 R24: floor すると実際には収まる
  // 混在幅の塊を clip 扱いにしてしまう)
  const labelChars = Math.max(0.1, labelW / fontMm);
  const valueChars = Math.max(0.1, valueW / fontMm);
  // 判定はページ内要素との交差にしか使わないため、高さ maxHeightMm (ページ高
  // 相当) 分を超えたら行数・走査とも打ち切ってよい (@codex #310 R17/R18:
  // 巨大セルの同期計測で main thread を塞がない・切り詰めは行数上限で行う)。
  const lineCap = Math.max(1, Math.ceil(maxHeightMm / lineMm));
  // セルは white-space: normal (@codex #310 R15): 連続空白・タブ・改行は
  // 1 つの空白に潰れ、空セルは文字行を作らない (collapseWs=true)。
  const cellLines = (s: string, chars: number): number =>
    measureParagraph(s, chars, mono, lineCap + 1, true).length;
  let total = 0;
  for (const r of el.rows) {
    const rowLines = Math.max(
      cellLines(r.label, labelChars),
      cellLines(r.value, valueChars),
    );
    // 空行でも罫線+上下 padding (≒1.4mm) は残る
    total += rowLines * lineMm + 1.4;
    if (total >= maxHeightMm) return total; // これ以上は判定に影響しない
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
  let run = 0;
  let max = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) <= 0xff) {
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        max = Math.max(max, run);
        run = 0;
        continue;
      }
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
      if (max >= capEm) return capEm; // これ以上は判定に影響しない
      continue;
    }
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
): number[] {
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
  const lineWidths: number[] = [];
  let cur = 0;
  let asciiRun = 0;
  let sawContent = false;
  let pendingWs = false; // collapseWs 用 (連続空白を 1 個に潰す)
  // 直前が clip 済み不可分塊の行末で、新しい行にまだ何も無い状態。
  // この直後の改行は「clip 行を終えるだけ」で新しい空行を作らない
  // (@codex #310 R20: 幻の空行で以降の行がズレるのを防ぐ)。
  let afterClip = false;
  const emitSpace = (): void => {
    afterClip = false;
    if (cur + SPACE_EM > charsPerLine) {
      lineWidths.push(cur);
      cur = SPACE_EM;
    } else {
      cur += SPACE_EM;
    }
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
      if (cur > 0) lineWidths.push(cur);
      lineWidths.push(Number.POSITIVE_INFINITY);
      cur = 0;
      afterClip = true;
      return;
    }
    afterClip = false;
    if (cur + w > charsPerLine) {
      lineWidths.push(cur);
      cur = w;
    } else {
      cur += w;
    }
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
    if (lineWidths.length >= maxLines) return lineWidths; // 可視行ぶん確定済み
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
      lineWidths.push(cur);
      cur = 0;
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
      } else if (ch === "\t") {
        // 次のタブストップへ送る (行幅は超えない)。タブ自体は折返し可能点。
        afterClip = false;
        cur = Math.min(
          charsPerLine,
          (Math.floor(cur / TAB_STOP_EM) + 1) * TAB_STOP_EM,
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
  if (cur > 0 || lineWidths.length === 0) lineWidths.push(cur);
  return lineWidths;
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
    const w = Math.min(el.w, lineChars[i] * fontMm);
    if (w <= 0) continue; // 空行は幅を持たない
    const x =
      el.style.align === "right"
        ? el.x + (el.w - w)
        : el.style.align === "center"
          ? el.x + (el.w - w) / 2
          : el.x;
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
 *   (はみ出して描画される表との重なりも検知する・@codex #310)
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
        (e.type === "text" && e.content.trim() !== "") ||
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
            rects: [
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
