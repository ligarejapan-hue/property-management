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

/**
 * 会社帯（company/company-details 要素）の高さ(mm)の既定値。`footerHeight` 入力の既定として
 * build-document.ts（作成時）と editor-document.ts（autoBalanceLayout・再バランス時）の
 * 両方が使う共有定数（会社帯自体の内容/行数は現状固定なので暫定値。将来Bで可変化）。
 * 他の定数と違い、この値だけは呼び出し側の footerHeight 引数の既定値として外部公開する。
 */
export const DEFAULT_FOOTER_H = 16;

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
// 写真敷詰め (packPhotoCells) — computeSpecSheetLayout と editor の autoArrangePhotos が使う
// （計画⑥から移設。以前は editor-document.ts にあり layout-engine と循環importになっていた）
// ---------------------------------------------------------------------------

/** 写真間の余白(mm)。テンプレの写真レイアウトと同じ。 */
const PHOTO_GAP_MM = 4;
/** セルの目標縦横比（3:2 横長）。行数の選択にのみ使う。 */
const PHOTO_TARGET_ASPECT = 1.5;
/** セル寸法の下限(mm)。editor の MIN_ELEMENT_SIZE_MM と同値（循環import回避のためローカル定義）。 */
const MIN_PHOTO_CELL_MM = 5;

export interface PhotoCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * n 個のセルを W×H の枠へ「行数を選び、各行は幅いっぱい均等割り」で敷き詰める
 * （穴なし・全行同高）。プロト autolayout-v4 の packCells をベースに 2 点調整:
 * - 行数の選択は「最悪セルの縦横比の PHOTO_TARGET_ASPECT からの乖離」を最小化
 *   （ミニマックス）。均等な配分（例: 4枚→2×2）が横長の帯より優先される。
 * - 端数は後方の行に配る＝先頭行が少列（幅広）になり、代表写真（配列先頭）が
 *   最上段の大きな枠を得る（テンプレの3枚レイアウトと同じ構造）。
 * セル寸法が非正になる行数は候補から除外し、全滅する極端な枚数では 1 行へ
 * フォールバックして MIN_PHOTO_CELL_MM でクランプ（非正寸法を返さないことを優先）。
 */
export function packPhotoCells(n: number, W: number, H: number): PhotoCell[] {
  const gap = PHOTO_GAP_MM;
  let best: { rows: number; counts: number[]; score: number } | null = null;
  for (let rows = 1; rows <= n; rows++) {
    const base = Math.floor(n / rows);
    const extra = n % rows;
    const counts: number[] = [];
    for (let r = 0; r < rows; r++) counts.push(base + (r >= rows - extra ? 1 : 0));
    const th = (H - (rows - 1) * gap) / rows;
    if (th <= 0) continue;
    let score = 0;
    for (const cols of counts) {
      const tw = (W - (cols - 1) * gap) / cols;
      if (tw <= 0) {
        score = Number.POSITIVE_INFINITY;
        break;
      }
      score = Math.max(score, Math.abs(Math.log(tw / th / PHOTO_TARGET_ASPECT)));
    }
    if (!Number.isFinite(score)) continue;
    if (!best || score < best.score) best = { rows, counts, score };
  }
  if (!best) {
    const w = Math.max(MIN_PHOTO_CELL_MM, (W - (n - 1) * gap) / n);
    const h = Math.max(MIN_PHOTO_CELL_MM, H);
    return Array.from({ length: n }, (_, c) => ({ x: c * (w + gap), y: 0, w, h }));
  }
  const { rows, counts } = best;
  const th = (H - (rows - 1) * gap) / rows;
  const cells: PhotoCell[] = [];
  for (let r = 0; r < rows; r++) {
    const cols = counts[r];
    const tw = (W - (cols - 1) * gap) / cols;
    for (let c = 0; c < cols; c++) {
      cells.push({ x: c * (tw + gap), y: r * (th + gap), w: tw, h: th });
    }
  }
  return cells;
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
