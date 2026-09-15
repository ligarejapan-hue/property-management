/**
 * layout-engine.ts
 *
 * 消費者向けひな型の座標計算と写真の敷き詰め。
 *
 * Pure / no side effects / no crypto.randomUUID — safe to call from reducers,
 * builders, or tests alike. This module has no knowledge of SalesSheetDocument /
 * element schema; later tasks map this layout onto element geometry (x/y/w/h)
 * via a builder.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// 写真敷詰め (packPhotoCells) — computeConsumerLayout と editor の autoArrangePhotos が使う
// （計画⑥から移設。以前は editor-document.ts にあり layout-engine と循環importになっていた）
// ---------------------------------------------------------------------------

/** 写真間の余白(mm)。テンプレの写真レイアウトと同じ。 */
export const PHOTO_GAP_MM = 4;
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
// 消費者向けひな型(2026-09・案3「整理型」)の紙面。仕様書 §3 / §4.4。
// ビルダー(build-document)とエディタ(editor-document)が同じ値を使う。
// ---------------------------------------------------------------------------

/** pt → mm。 */
export const PT_TO_MM = 25.4 / 72;
/** 表の行高の見積もりに使う行間。 */
const CONSUMER_LINE_HEIGHT = 1.35;
export const MAIN_TABLE_FONT_PT = { start: 12, min: 11 } as const;
export const DETAIL_TABLE_FONT_PT = { start: 10, min: 8 } as const;
export const MAIN_TABLE_PAD_MM = 1.2;
export const DETAIL_TABLE_PAD_MM = 0.8;
const FONT_STEP_PT = 0.5;
/** 表の最小高さ(mm)。schema は正の寸法を要求し、エディタの最小要素サイズと同じ。 */
const MIN_TABLE_H_MM = 5;

const RIGHT_X_MM = 136;
const RIGHT_W_MM = 154;
const TABLE_TOP_MM = 43.5;
const TABLE_GAP_MM = 2.5;
const RIGHT_BOTTOM_MM = 167.5;
const DETAIL_COL_GAP_MM = 3;

export const CONSUMER_PHOTO_ZONE: Rect = { x: 7, y: 19.5, w: 124, h: 148 };
export const CONSUMER_FOOTER: Rect = { x: 7, y: 185, w: 283, h: 25 };
/** 地図QRの置き場(会社帯の右端)。 */
export const CONSUMER_MAP_QR_SLOT: Rect = { x: 269, y: 187, w: 20, h: 20 };

export interface ConsumerLayout {
  catchBand: Rect;
  catchCopy: Rect;
  kindTag: Rect;
  heading: Rect;
  price: Rect;
  mainTable: Rect & { fontSizePt: number };
  detailLeft: Rect;
  detailRight: Rect;
  detailFontSizePt: number;
  salesPointsBand: Rect;
  salesPoints: Rect;
  footer: Rect;
  photoZone: Rect;
  mapQrSlot: Rect;
  /** 詳細表が下限の文字でも入りきらない見込み。 */
  overflow: boolean;
}

/** 表1行の高さの見積もり(mm)= 文字×行間 + 上下余白。 */
export function tableRowHeightMm(fontPt: number, padMm: number): number {
  return fontPt * PT_TO_MM * CONSUMER_LINE_HEIGHT + padMm * 2;
}

function fontSteps(start: number, min: number): number[] {
  const out: number[] = [];
  for (let pt = start; pt >= min - 1e-9; pt -= FONT_STEP_PT) out.push(Math.round(pt * 10) / 10);
  return out;
}

/** 主要表をなるべく大きく保ち、詳細表を枠に入る最大の文字にする。入らなければ下限+overflow。 */
function chooseTableFonts(
  mainRows: number,
  perColumn: number,
): { mainPt: number; detailPt: number; overflow: boolean } {
  const areaH = RIGHT_BOTTOM_MM - TABLE_TOP_MM;
  for (const mainPt of fontSteps(MAIN_TABLE_FONT_PT.start, MAIN_TABLE_FONT_PT.min)) {
    const avail = areaH - mainRows * tableRowHeightMm(mainPt, MAIN_TABLE_PAD_MM) - TABLE_GAP_MM;
    if (avail < 0) continue;
    if (perColumn === 0) return { mainPt, detailPt: DETAIL_TABLE_FONT_PT.start, overflow: false };
    for (const detailPt of fontSteps(DETAIL_TABLE_FONT_PT.start, DETAIL_TABLE_FONT_PT.min)) {
      if (perColumn * tableRowHeightMm(detailPt, DETAIL_TABLE_PAD_MM) <= avail + 1e-9) {
        return { mainPt, detailPt, overflow: false };
      }
    }
  }
  return { mainPt: MAIN_TABLE_FONT_PT.min, detailPt: DETAIL_TABLE_FONT_PT.min, overflow: true };
}

/** 消費者向けひな型の紙面(A4横)を、主要表・詳細表の行数から決定的に計算する純関数。 */
export function computeConsumerLayout(input: { mainRowCount: number; detailRowCount: number }): ConsumerLayout {
  const mainRows = Math.max(0, input.mainRowCount);
  const perColumn = Math.ceil(Math.max(0, input.detailRowCount) / 2);
  const fonts = chooseTableFonts(mainRows, perColumn);

  // 主要表の高さを枠内に留め、詳細表が右列の下限を超えないようにする。
  const maxMainH = RIGHT_BOTTOM_MM - TABLE_TOP_MM - TABLE_GAP_MM - MIN_TABLE_H_MM;
  const rawMainH = mainRows * tableRowHeightMm(fonts.mainPt, MAIN_TABLE_PAD_MM);
  const mainH = Math.min(maxMainH, Math.max(MIN_TABLE_H_MM, rawMainH));
  const detailY = TABLE_TOP_MM + mainH + TABLE_GAP_MM;
  const detailH = Math.max(MIN_TABLE_H_MM, RIGHT_BOTTOM_MM - detailY);
  const detailW = (RIGHT_W_MM - DETAIL_COL_GAP_MM) / 2;

  return {
    catchBand: { x: 0, y: 0, w: 297, h: 16 },
    catchCopy: { x: 9, y: 0, w: 220, h: 16 },
    kindTag: { x: 232, y: 0, w: 56, h: 16 },
    heading: { x: RIGHT_X_MM, y: 19.5, w: RIGHT_W_MM, h: 8 },
    price: { x: RIGHT_X_MM, y: 28, w: RIGHT_W_MM, h: 14 },
    mainTable: { x: RIGHT_X_MM, y: TABLE_TOP_MM, w: RIGHT_W_MM, h: mainH, fontSizePt: fonts.mainPt },
    detailLeft: { x: RIGHT_X_MM, y: detailY, w: detailW, h: detailH },
    detailRight: { x: RIGHT_X_MM + detailW + DETAIL_COL_GAP_MM, y: detailY, w: detailW, h: detailH },
    detailFontSizePt: fonts.detailPt,
    salesPointsBand: { x: 7, y: 170, w: 283, h: 12 },
    salesPoints: { x: 11, y: 170, w: 275, h: 12 },
    footer: { ...CONSUMER_FOOTER },
    photoZone: { ...CONSUMER_PHOTO_ZONE },
    mapQrSlot: { ...CONSUMER_MAP_QR_SLOT },
    overflow: fonts.overflow || rawMainH > maxMainH,
  };
}
