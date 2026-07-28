/**
 * 踏破ヒート（巡回で歩いた場所の蓄積表示）の純関数。
 *
 * 業務目的（ユーザー 2026-07-28）: 街を歩いて目視で古い家を探すため、
 * **短期間に同じ道を二度歩くのは無駄**。どこを踏破済みかを全員で溜めて、
 * 次に回るエリアを決める。管理者は未踏破エリアへ指示を出す。
 *
 * ⚠色は**最初から全社合計**。「Aさんが1度通れば1回、Bさんが1度通れば2回」で、
 * 誰の分かを一切区別しない（ユーザー明示）。したがってこの層は staff を持たず、
 * 返すのは**格子番号と回数だけ**（人名・日時を持たない）＝生座標より PII 露出面が小さい。
 *
 * DB 変更なしで成立させるため、集計は lat/lng を格子幅で floor した整数を
 * GROUP BY するだけにしてある（schema 変更・index 追加なし）。
 */

/**
 * 緯度1度あたりの距離(m)。日本の緯度帯で実用上一定。
 * 経度側は cos(緯度) で縮むので、対象地域の代表緯度で固定係数化する。
 * ⚠可変にすると GROUP BY 式が非決定的になり、pan するだけでセル境界が動いて
 * 色がちらつく。固定が正しい。
 */
const METERS_PER_DEG_LAT = 111_320;

/** 係数を固定する代表緯度（日本の主要都市帯）。cos(35.7°) ≒ 0.8121。 */
const REFERENCE_COS_LAT = 0.8121;

/** 経度1度あたりの距離(m)（代表緯度での固定値）。 */
const METERS_PER_DEG_LNG = METERS_PER_DEG_LAT * REFERENCE_COS_LAT;

/** 格子の粗さ。fine=街歩き / mid=市内 / wide=市外まで。 */
export type CoverageCellSize = "fine" | "mid" | "wide";

export const COVERAGE_CELL_SIZES = ["fine", "mid", "wide"] as const;

export interface CoverageCellStep {
  /** 緯度方向の格子幅（度）。 */
  latStep: number;
  /** 経度方向の格子幅（度）。 */
  lngStep: number;
}

/**
 * 粒度ごとの格子幅。
 *
 * ⚠**粗い段は細かい段のちょうど5倍**にしてある。これにより粗いセルは細かい
 * セル 5×5 をきれいに束ねた形になり、寄り引きで境界が食い違わない
 * （= 同じ道が寄ると青、引くと赤、のような矛盾が起きない）。
 *
 * 実寸（代表緯度）:
 *   fine 0.00045° ≒ 50.1m / 0.00055° ≒ 49.7m
 *   mid  0.00225° ≒ 250m  / 0.00275° ≒ 249m
 *   wide 0.01125° ≒ 1.25km / 0.01375° ≒ 1.24km
 */
export const COVERAGE_CELL_STEPS: Readonly<
  Record<CoverageCellSize, CoverageCellStep>
> = {
  fine: { latStep: 0.00045, lngStep: 0.00055 },
  mid: { latStep: 0.00225, lngStep: 0.00275 },
  wide: { latStep: 0.01125, lngStep: 0.01375 },
};

/** 1リクエストで返すセル数の上限。超えたら fail-closed（色を出さない）。 */
export const COVERAGE_CELL_LIMIT = 2000;

/**
 * 各段が担当できる bbox の一辺（度）の上限。
 *
 * ⚠**上限セル数から逆算する**。ここを緩めると、歩き尽くしたエリアに寄ったときに
 * セル数が上限を超え、fail-closed で**色が全部消える**。この画面は
 * 「色が無い＝誰も通っていない」と読ませるので、それは
 * **踏破済みのエリアへ人を送り出す**という最悪の壊れ方になる。
 *
 * 42 セル分を上限にしてあるのは、(a) bbox が格子に整列していないと縦横それぞれ
 * 1 行ずつ余分に掛かる (b) 判定の許容誤差 SPAN_EPSILON_DEG がさらに 1 行を跨ぎ得る
 * ため。42 + 1 + 1 = 44 で 44×44 = 1,936 ≤ 2,000 に必ず収まる。
 * この不変条件は field-survey-coverage.test.ts で全段について検査している。
 */
const MAX_CELLS_PER_AXIS = 42;

const FINE_MAX_LAT_DEG = COVERAGE_CELL_STEPS.fine.latStep * MAX_CELLS_PER_AXIS; // ≒ 2.15km
const FINE_MAX_LNG_DEG = COVERAGE_CELL_STEPS.fine.lngStep * MAX_CELLS_PER_AXIS; // ≒ 2.14km
const MID_MAX_LAT_DEG = COVERAGE_CELL_STEPS.mid.latStep * MAX_CELLS_PER_AXIS; // ≒ 10.8km
const MID_MAX_LNG_DEG = COVERAGE_CELL_STEPS.mid.lngStep * MAX_CELLS_PER_AXIS; // ≒ 10.7km

/**
 * その bbox をその段で描いたときに掛かりうる**最大**セル数。
 * bbox は格子に整列していないので、縦横それぞれ 1 行ずつ余分に見る。
 * 「上限に収まるか」を実際に検査できるようにするための関数。
 */
export function maxCellsForBbox(
  bbox: CoverageBbox,
  cell: CoverageCellSize,
): number {
  const { latStep, lngStep } = COVERAGE_CELL_STEPS[cell];
  // ⚠ceil の前に塵を落とす。0.01935 / 0.00045 が 43.000000000000007 になり、
  // 1 行余分に数えて上限判定が誤って落ちる（実際に踏んだ）。
  const rows = Math.ceil(Math.abs(bbox.north - bbox.south) / latStep - 1e-9) + 1;
  const cols = Math.ceil(Math.abs(bbox.east - bbox.west) / lngStep - 1e-9) + 1;
  return rows * cols;
}

/** 1段粗い粒度。wide より粗い段は無いので null。 */
export function coarserCoverageCellSize(
  cell: CoverageCellSize,
): CoverageCellSize | null {
  if (cell === "fine") return "mid";
  if (cell === "mid") return "wide";
  return null;
}

export interface CoverageBbox {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * bbox の広さから格子の粗さを決める。**利用者に選ばせない**（手数の純増になる）。
 * 寄れば細かく、引けば粗くなる。
 */
/**
 * 境界比較の許容誤差（度）。
 *
 * ⚠bbox は地図の表示範囲から来る浮動小数で、`35.68 + 0.027 - 35.68` が
 * 0.027 をわずかに超えるような誤差が普通に出る。誤差だけで 1 段粗くなると
 * 「同じ寄りなのにマスの大きさが変わる」ちらつきになるので、境界は緩く見る。
 * 1e-9 度 ≒ 0.1mm 相当なので業務上の意味は無い。
 */
const SPAN_EPSILON_DEG = 1e-9;

export function resolveCoverageCellSize(bbox: CoverageBbox): CoverageCellSize {
  const latSpan = Math.abs(bbox.north - bbox.south);
  const lngSpan = Math.abs(bbox.east - bbox.west);
  if (
    latSpan <= FINE_MAX_LAT_DEG + SPAN_EPSILON_DEG &&
    lngSpan <= FINE_MAX_LNG_DEG + SPAN_EPSILON_DEG
  ) {
    return "fine";
  }
  if (
    latSpan <= MID_MAX_LAT_DEG + SPAN_EPSILON_DEG &&
    lngSpan <= MID_MAX_LNG_DEG + SPAN_EPSILON_DEG
  ) {
    return "mid";
  }
  return "wide";
}

/** その粒度の 1 セルの実寸（m）。画面に「1マス 約50m」と出すため。 */
export function coverageCellMeters(cell: CoverageCellSize): {
  lat: number;
  lng: number;
} {
  const { latStep, lngStep } = COVERAGE_CELL_STEPS[cell];
  return {
    lat: Math.round(latStep * METERS_PER_DEG_LAT),
    lng: Math.round(lngStep * METERS_PER_DEG_LNG),
  };
}

/** 画面表示用の丸めた実寸ラベル（例「約50m」「約1.3km」）。 */
export function coverageCellLabel(cell: CoverageCellSize): string {
  const m = coverageCellMeters(cell).lat;
  if (m >= 1000) return `約${(m / 1000).toFixed(1)}km`;
  return `約${m}m`;
}

/** 集計結果の 1 セル。**格子番号と回数だけ**（生座標・人名・日時を持たない）。 */
export interface CoverageCell {
  /** 緯度方向の格子番号 = floor(lat / latStep)。 */
  y: number;
  /** 経度方向の格子番号 = floor(lng / lngStep)。 */
  x: number;
  /**
   * 通った回数（全社合計）。
   *
   * 数え方 = **(担当者, 通った日) の組の数**（ユーザー決定 2026-07-28）:
   * 同じ人が同じ日に何度通っても1回／別の人なら別に数える。
   * 日付は JST の暦日で切る。
   */
  p: number;
}

/** セル番号から地図に描く矩形の四隅（度）へ戻す。 */
export function coverageCellBounds(
  cellIndex: { x: number; y: number },
  step: CoverageCellStep,
): CoverageBbox {
  const south = cellIndex.y * step.latStep;
  const west = cellIndex.x * step.lngStep;
  return {
    south,
    west,
    north: south + step.latStep,
    east: west + step.lngStep,
  };
}

/** 座標 → セル番号（集計 SQL の floor と同じ規則）。 */
export function coverageCellIndexOf(
  lat: number,
  lng: number,
  step: CoverageCellStep,
): { x: number; y: number } {
  return {
    y: Math.floor(lat / step.latStep),
    x: Math.floor(lng / step.lngStep),
  };
}

/**
 * 回数 → 色の段。
 *
 * ⚠4段までにする。半透明の塗りを屋外のスマホ画面で見分けるので、5段以上は
 * 隣の段と区別できない。
 * ⚠最上位を Google 既定の赤（登録済み物件マーカー #EA4335）と混同しない
 * 暗赤にしている。
 */
export type CoverageHeatTier = 1 | 2 | 3 | 4;

export function coverageHeatTier(passes: number): CoverageHeatTier | null {
  if (!Number.isFinite(passes) || passes <= 0) return null;
  if (passes === 1) return 1;
  if (passes <= 3) return 2;
  if (passes <= 6) return 3;
  return 4;
}

export interface CoverageHeatStyle {
  fillColor: string;
  fillOpacity: number;
  /** 凡例に出す説明（業務の言葉）。 */
  label: string;
  /** 凡例に出す回数の表記。 */
  countLabel: string;
}

/**
 * 段ごとの塗り。**枠線は引かない**（50m 格子の枠線は道路名を潰し、
 * 「地図を見やすくする」という今回の趣旨に逆行する）。
 * 色相と不透明度の二重表現にしてあるので、色覚特性によらず順序が読める。
 */
export const COVERAGE_HEAT_STYLES: Readonly<
  Record<CoverageHeatTier, CoverageHeatStyle>
> = {
  1: {
    fillColor: "#93C5FD",
    fillOpacity: 0.3,
    label: "一度は通った",
    countLabel: "1回",
  },
  2: {
    fillColor: "#A78BFA",
    fillOpacity: 0.35,
    label: "そろそろ十分",
    countLabel: "2〜3回",
  },
  3: {
    fillColor: "#FB7185",
    fillOpacity: 0.4,
    label: "重複気味",
    countLabel: "4〜6回",
  },
  4: {
    fillColor: "#B91C1C",
    fillOpacity: 0.45,
    label: "明確に無駄",
    countLabel: "7回以上",
  },
};

/** 期間の選択肢（日数）。0 = 全期間。ユーザー決定: 1年 または 全期間のみ。 */
export const COVERAGE_PERIOD_DAYS = [365, 0] as const;
export type CoveragePeriodDays = (typeof COVERAGE_PERIOD_DAYS)[number];

export const COVERAGE_DEFAULT_DAYS: CoveragePeriodDays = 365;

/** 期間の表示名。 */
export function coveragePeriodLabel(days: number): string {
  return days === 0 ? "全期間" : `直近${Math.round(days / 365)}年`;
}

/**
 * 期間（日数）→ 集計の下限時刻。0（全期間）は null。
 * now を引数に取るのは、テストで時刻を固定するため。
 */
export function coverageFromAt(days: number, now: Date): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * 同じ色のセルをまとめる（描画する図形の数を抑えるため）。
 * 1セル1オーバーレイにすると数千個になるので、段ごとに 1 図形へ束ねる。
 */
export function groupCoverageCellsByTier(
  cells: readonly CoverageCell[],
): Map<CoverageHeatTier, CoverageCell[]> {
  const grouped = new Map<CoverageHeatTier, CoverageCell[]>();
  for (const cell of cells) {
    const tier = coverageHeatTier(cell.p);
    if (tier === null) continue;
    const list = grouped.get(tier);
    if (list) list.push(cell);
    else grouped.set(tier, [cell]);
  }
  return grouped;
}
