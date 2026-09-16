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
// 写真の置き場の共通値 — build-document(作成時の初期配置)と editor-document(並べ直し)が使う
// ---------------------------------------------------------------------------

/** 写真間の余白(mm)。 */
export const PHOTO_GAP_MM = 4;
/** 作成時に写真へ付ける角丸(mm)。間取り図には付けない。 */
export const CONSUMER_PHOTO_RADIUS_MM = 2;
/** 作成時の写真・間取り図の重ね順。 */
export const CONSUMER_PHOTO_Z = 1;
/** セル寸法の下限(mm)。editor の MIN_ELEMENT_SIZE_MM と同値（循環import回避のためローカル定義）。 */
const MIN_PHOTO_CELL_MM = 5;

export interface PhotoCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// 主役1枚+残りは全部同じ大きさ(販売図面 第②段・発注者判断 2026-09-16)
// ---------------------------------------------------------------------------

/** 主役の高さ = (写真枠の高さ - 間隔) × この比率。残りは下側に並ぶ。 */
export const HERO_HEIGHT_RATIO = 0.55;
/**
 * 同じ大きさの格子を選ぶときに近づける縦横比(4:3 横長=一般的な写真)。写真は切らずに
 * 全体を見せる(fit:contain)ため、各写真の実際の縦横には合わせない=並べ方は枚数だけで決まる。
 */
const UNIFORM_CELL_TARGET_ASPECT = 4 / 3;

/** m 個を W×H へ全部同じ大きさで並べる(行×列を選ぶ・左上から詰める)。 */
function uniformGridCells(m: number, W: number, H: number): PhotoCell[] {
  if (m <= 0) return [];
  const gap = PHOTO_GAP_MM;
  let best: { cols: number; cw: number; ch: number; score: number; empty: number } | null = null;
  for (let cols = 1; cols <= m; cols++) {
    const rows = Math.ceil(m / cols);
    const cw = (W - (cols - 1) * gap) / cols;
    const ch = (H - (rows - 1) * gap) / rows;
    if (cw <= 0 || ch <= 0) continue;
    const score = Math.abs(Math.log(cw / ch / UNIFORM_CELL_TARGET_ASPECT));
    const empty = rows * cols - m;
    // 形の近さが同じなら空きマスの少ない方(例: 3枚で 2×2 より 1×3 が同点ならこちら)。
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && empty < best.empty)) {
      best = { cols, cw, ch, score, empty };
    }
  }
  if (!best) {
    const w = Math.max(MIN_PHOTO_CELL_MM, W);
    const h = Math.max(MIN_PHOTO_CELL_MM, (H - (m - 1) * gap) / m);
    return Array.from({ length: m }, (_, i) => ({ x: 0, y: i * (h + gap), w, h }));
  }
  const { cols, cw, ch } = best;
  return Array.from({ length: m }, (_, i) => ({
    x: (i % cols) * (cw + gap),
    y: Math.floor(i / cols) * (ch + gap),
    w: cw,
    h: ch,
  }));
}

/**
 * n 枚を W×H の写真枠へ「主役1枚を上に大きく+残りはその下に全部同じ大きさ」で並べる。
 * heroIndex が null/範囲外なら全部同じ大きさ。1枚なら主役の有無にかかわらず枠いっぱい。
 * 戻り値は入力と同じ並び(i 番目 = i 番目の写真の枠)。純・決定的。
 */
export function heroGridCells(n: number, heroIndex: number | null, W: number, H: number): PhotoCell[] {
  if (n <= 0) return [];
  const hasHero = heroIndex !== null && heroIndex >= 0 && heroIndex < n && n > 1;
  if (!hasHero) return uniformGridCells(n, W, H);
  const gap = PHOTO_GAP_MM;
  const heroH = (H - gap) * HERO_HEIGHT_RATIO;
  const restTop = heroH + gap;
  const rest = uniformGridCells(n - 1, W, H - restTop).map((c) => ({ ...c, y: c.y + restTop }));
  const out: PhotoCell[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    out.push(i === heroIndex ? { x: 0, y: 0, w: W, h: heroH } : rest[k++]);
  }
  return out;
}

/**
 * 今の大きさを保ったまま、写真枠の左上から行ごとに詰め直す(「写真を自動整列」)。
 * - 並び順は主役(heroIndex)が先頭、残りは配列順。
 * - 枠より横に広い写真は縦横比を保って枠の幅まで縮める。
 * - 全体が枠の高さに入りきらなければ、全部を**同じ割合で**縮めて収める(大きさの比は保つ)。
 * 戻り値は入力と同じ並び。純・決定的。
 */
export function repackKeepingSizes(
  sizes: readonly { w: number; h: number }[],
  heroIndex: number | null,
  W: number,
  H: number,
): PhotoCell[] {
  const n = sizes.length;
  if (n === 0) return [];
  const gap = PHOTO_GAP_MM;
  const order: number[] = [];
  if (heroIndex !== null && heroIndex >= 0 && heroIndex < n) order.push(heroIndex);
  for (let i = 0; i < n; i++) if (i !== heroIndex) order.push(i);

  const place = (scale: number): { cells: PhotoCell[]; height: number } => {
    const cells: PhotoCell[] = new Array(n);
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const i of order) {
      let w = Math.max(MIN_PHOTO_CELL_MM, sizes[i].w * scale);
      let h = Math.max(MIN_PHOTO_CELL_MM, sizes[i].h * scale);
      if (w > W) {
        h = Math.max(MIN_PHOTO_CELL_MM, (h * W) / w);
        w = W;
      }
      if (x > 0 && x + w > W + 1e-9) {
        x = 0;
        y += rowH + gap;
        rowH = 0;
      }
      cells[i] = { x, y, w, h };
      x += w + gap;
      rowH = Math.max(rowH, h);
    }
    return { cells, height: y + rowH };
  };

  const full = place(1);
  if (full.height <= H + 1e-9) return full.cells;
  // 入りきる最大の縮小率を二分探索(同じ割合で縮める)。
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    if (place(mid).height <= H + 1e-9) lo = mid;
    else hi = mid;
  }
  return place(lo).cells;
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

/**
 * 消費者向けひな型の紙面(A4横)を、主要表・詳細表の行数から決定的に計算する純関数。
 *
 * `detailPerColumn` は左右の詳細表の行数が偏っている場合に、多い方の行数を渡す
 * (編集画面では片方の表だけ行を足したり減らしたりできるため、`detailRowCount`
 * の合計を単純に2等分すると、行数が多い側の表がはみ出す/枠を突き破ることがある)。
 * 省略時は従来どおり `detailRowCount / 2` の切り上げを使う。
 */
export function computeConsumerLayout(input: {
  mainRowCount: number;
  detailRowCount: number;
  detailPerColumn?: number;
}): ConsumerLayout {
  const mainRows = Math.max(0, input.mainRowCount);
  const perColumn = Math.max(0, Math.ceil(input.detailPerColumn ?? Math.max(0, input.detailRowCount) / 2));
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
