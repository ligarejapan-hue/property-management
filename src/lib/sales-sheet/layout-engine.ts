/**
 * layout-engine.ts
 *
 * Pure layout-optimization function for the 自社様式マイソク (spec-sheet) template.
 * Given a handful of content-shape inputs (photo count, spec-table row count,
 * floor-plan presence, footer band height), computes an absolute mm-coordinate
 * layout (A4 landscape: 297×210mm) for every region of the sheet.
 *
 * Pure / no side effects / no crypto.randomUUID — safe to call from reducers,
 * builders, or tests alike. This module has no knowledge of SalesSheetDocument /
 * element schema; later tasks map this layout onto element geometry (x/y/w/h)
 * via a builder.
 */

import { packPhotoCells } from "./editor-document";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SpecSheetLayoutInput {
  /** 掲載する写真の枚数 (0..3)。 */
  photoCount: number;
  /** 概要表の行数。多いほどフォントが小さくなる。 */
  specRowCount: number;
  /** 間取り図を配置するか。 */
  hasFloorPlan: boolean;
  /** 下部帯（会社情報帯）の高さ(mm)。大きいほどメイン領域が縮む。 */
  footerHeight: number;
  /** 概要表フォント(pt)の明示上書き。省略時は行数から自動計算。 */
  overviewFontPt?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpecSheetLayout {
  catchBand: Rect;
  catchCopy: Rect;
  heading: Rect;
  price: Rect;
  overview: Rect & { fontSizePt: number };
  salesPoints: Rect;
  company: Rect;
  companyDetails: Rect;
  floorPlan: Rect | null;
  photoArea: Rect;
  photoSlots: Rect[];
}

// ---------------------------------------------------------------------------
// Constants (A4 landscape mm; see feature plan's algorithm design memo)
// ---------------------------------------------------------------------------

/** ページ高さ(mm)。mainBottom(=メイン領域の下端)の起点。 */
const PAGE_H_MM = 210;

/** 上部キャッチ帯 — 固定 (photoCount 等に依存しない)。 */
const CATCH_BAND: Rect = { x: 10, y: 8, w: 277, h: 16 };
const CATCH_COPY: Rect = { x: 16, y: 8, w: 265, h: 16 };

/** メイン領域の上端。 */
const MAIN_TOP_MM = 26;
/** footer 帯とメイン領域の間の余白(mm)。mainBottom = 210 − footerHeight − この値。 */
const MAIN_BOTTOM_MARGIN_MM = 2;

/** 左右分割線 splitX の可動域。写真0枚→94寄り（overview を広く＝写真少なら表広く）／3枚→145寄り（写真域広め）。 */
const SPLIT_X_MIN_MM = 94;
const SPLIT_X_MAX_MM = 145;
/** splitX 補間の t を作るための photoCount 正規化の分母（0..3枚 → 0..1）。 */
const SPLIT_X_PHOTO_COUNT_DIVISOR = 3;
/** splitX と photoArea 右端の間の余白(mm)。 */
const COLUMN_GAP_MM = 6;

/** overview（概要表）の右端 x 座標。 */
const OVERVIEW_RIGHT_MM = 287;
/** overview.x は splitX からこの分だけ右にオフセット。 */
const OVERVIEW_X_OFFSET_MM = 5;
/** overview フォント自動計算: clamp(h / rows / DIVISOR, MIN, MAX)。 */
const OVERVIEW_FONT_MIN_PT = 5;
const OVERVIEW_FONT_MAX_PT = 9;
const OVERVIEW_FONT_HEIGHT_DIVISOR = 1.6;

/** photoArea の原点。 */
const PHOTO_AREA_X_MM = 10;
const PHOTO_AREA_Y_MM = 46;

/** heading / price（左カラム上部）。 */
const HEADING_X_MM = 10;
const HEADING_Y_MM = 26;
const HEADING_H_MM = 7;
const PRICE_X_MM = 10;
const PRICE_Y_MM = 33;
const PRICE_H_MM = 12;
/** heading.w = price.w = splitX − この値。 */
const LEFT_COLUMN_WIDTH_MARGIN_MM = 16;

/** salesPoints（写真域の下端付近の帯）。 */
const SALES_POINTS_X_MM = 10;
const SALES_POINTS_W_MM = 136;
const SALES_POINTS_H_MM = 7;
/** salesPoints.y = mainBottom − この値。 */
const SALES_POINTS_BOTTOM_OFFSET_MM = 7;

/** company / companyDetails（最下部の会社情報帯）。 */
const COMPANY_X_MM = 10;
const COMPANY_W_MM = 277;
const COMPANY_H_MM = 6;
const COMPANY_DETAILS_H_MM = 7;
/** companyDetails.y = mainBottom + この値（= company.h）。 */
const COMPANY_DETAILS_Y_OFFSET_MM = 6;

/** floorPlan（間取り図・hasFloorPlan 時のみ）。 */
const FLOOR_PLAN_RECT: Rect = { x: 108, y: 26, w: 32, h: 18 };

// ---------------------------------------------------------------------------
// Local math helpers (pure)
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

// ---------------------------------------------------------------------------
// computeSpecSheetLayout
// ---------------------------------------------------------------------------

/**
 * A4横(297×210mm)のマイソク版面レイアウトを、写真枚数・概要表行数・間取り図
 * 有無・footer 高さから決定的に計算する純関数。
 *
 * - 左右分割線 splitX は写真枚数に応じて 94..145mm を線形補間: 写真が多いほど
 *   右へ寄り、写真域（左）が広く／overview=概要表（右）が狭くなる（写真が少ないほど
 *   表が広い＝写真0枚で最も広い）。
 * - overview のフォントサイズは省略時、高さと行数から自動計算し 5..9pt にクランプ。
 * - photoCount=0 では packPhotoCells が空配列を返し写真は置かれない（photoArea の幅は
 *   予約値のまま・写真が無いので使われない）。左右分割は splitX ベースで連続変化する。
 * - photoSlots は packPhotoCells（既存の写真敷詰めアルゴリズム）を再利用し、
 *   photoArea 原点からの相対セルを絶対座標へ変換したもの。
 */
export function computeSpecSheetLayout(input: SpecSheetLayoutInput): SpecSheetLayout {
  const { photoCount, specRowCount, hasFloorPlan, footerHeight, overviewFontPt } = input;

  const mainBottom = PAGE_H_MM - footerHeight - MAIN_BOTTOM_MARGIN_MM;

  const splitRatio = clamp(photoCount / SPLIT_X_PHOTO_COUNT_DIVISOR, 0, 1);
  const splitX = lerp(SPLIT_X_MIN_MM, SPLIT_X_MAX_MM, splitRatio);

  const overviewX = splitX + OVERVIEW_X_OFFSET_MM;
  const overviewW = OVERVIEW_RIGHT_MM - overviewX;
  const overviewH = mainBottom - MAIN_TOP_MM;
  const overviewFontSizePt =
    overviewFontPt ??
    clamp(
      overviewH / Math.max(1, specRowCount) / OVERVIEW_FONT_HEIGHT_DIVISOR,
      OVERVIEW_FONT_MIN_PT,
      OVERVIEW_FONT_MAX_PT,
    );

  const overview: Rect & { fontSizePt: number } = {
    x: overviewX,
    y: MAIN_TOP_MM,
    w: overviewW,
    h: overviewH,
    fontSizePt: overviewFontSizePt,
  };

  const photoAreaW = Math.max(0, splitX - PHOTO_AREA_X_MM - COLUMN_GAP_MM);
  const photoAreaH = mainBottom - PHOTO_AREA_Y_MM;
  const photoArea: Rect = { x: PHOTO_AREA_X_MM, y: PHOTO_AREA_Y_MM, w: photoAreaW, h: photoAreaH };

  const photoSlots: Rect[] = packPhotoCells(photoCount, photoArea.w, photoArea.h).map((cell) => ({
    x: photoArea.x + cell.x,
    y: photoArea.y + cell.y,
    w: cell.w,
    h: cell.h,
  }));

  const leftColumnW = splitX - LEFT_COLUMN_WIDTH_MARGIN_MM;
  const heading: Rect = { x: HEADING_X_MM, y: HEADING_Y_MM, w: leftColumnW, h: HEADING_H_MM };
  const price: Rect = { x: PRICE_X_MM, y: PRICE_Y_MM, w: leftColumnW, h: PRICE_H_MM };

  const salesPoints: Rect = {
    x: SALES_POINTS_X_MM,
    y: mainBottom - SALES_POINTS_BOTTOM_OFFSET_MM,
    w: SALES_POINTS_W_MM,
    h: SALES_POINTS_H_MM,
  };

  const company: Rect = { x: COMPANY_X_MM, y: mainBottom, w: COMPANY_W_MM, h: COMPANY_H_MM };
  const companyDetails: Rect = {
    x: COMPANY_X_MM,
    y: mainBottom + COMPANY_DETAILS_Y_OFFSET_MM,
    w: COMPANY_W_MM,
    h: COMPANY_DETAILS_H_MM,
  };

  const floorPlan: Rect | null = hasFloorPlan ? { ...FLOOR_PLAN_RECT } : null;

  return {
    catchBand: { ...CATCH_BAND },
    catchCopy: { ...CATCH_COPY },
    heading,
    price,
    overview,
    salesPoints,
    company,
    companyDetails,
    floorPlan,
    photoArea,
    photoSlots,
  };
}
