/**
 * 地図データの取得計画(第3弾 B4)。
 *
 * 従来は「レイヤーの ON/OFF・期間・更新のどれかが変わったら、有効なレイヤーを
 * すべて取り直す」だけだった。そのため
 *  - ピンを OFF にしただけで物件・面・線まで取り直す(通信も待ち時間も4倍)
 *  - 取得のたびに面と線を空にするので、動かすたび色が消えて「歩いていない」
 *    ように見える
 * という2つの不便が出ていた。
 *
 * 何を取り何を消すかは**状態の差分だけで決まる純関数**にして、地図本体からは
 * 判断を追い出す(取得の順番が交差しても結論が変わらない)。
 */

export type MapLayerKey = "properties" | "pins" | "coverage" | "tracks";

export interface MapLayerFlags {
  properties: boolean;
  pins: boolean;
  coverage: boolean;
  tracks: boolean;
}

export interface MapFetchInputs {
  layers: MapLayerFlags;
  /** 期間(日数)。0=全期間。面と線だけがこの値に依存する。 */
  coverageDays: number;
  /** 表示範囲の同一性を表す鍵。変われば全レイヤーが取り直しになる。 */
  bboxKey: string;
  /** 「更新」や自分の操作後の取り直し要求。増えたら全レイヤー取り直し。 */
  refetchNonce: number;
}

export interface MapFetchPlan {
  /** 取りに行くレイヤー。 */
  fetch: Record<MapLayerKey, boolean>;
  /** 取りに行かず、表示だけ消すレイヤー(OFF にされたもの)。 */
  clear: Record<MapLayerKey, boolean>;
}

const ALL_KEYS: readonly MapLayerKey[] = [
  "properties",
  "pins",
  "coverage",
  "tracks",
];

/** 期間(coverageDays)に依存するのは面と線だけ。 */
const PERIOD_DEPENDENT: readonly MapLayerKey[] = ["coverage", "tracks"];

export function planMapFetch(
  prev: MapFetchInputs | null,
  next: MapFetchInputs,
): MapFetchPlan {
  const fetch: Record<MapLayerKey, boolean> = {
    properties: false,
    pins: false,
    coverage: false,
    tracks: false,
  };
  const clear: Record<MapLayerKey, boolean> = {
    properties: false,
    pins: false,
    coverage: false,
    tracks: false,
  };

  // 全レイヤーを取り直す条件: 初回 / 表示範囲が変わった / 更新を要求された。
  const refetchAll =
    prev === null ||
    prev.bboxKey !== next.bboxKey ||
    prev.refetchNonce !== next.refetchNonce;
  const periodChanged = prev !== null && prev.coverageDays !== next.coverageDays;

  for (const key of ALL_KEYS) {
    const on = next.layers[key];
    if (!on) {
      // OFF のレイヤーは絶対に取りに行かない。直前まで ON だったものだけ消す
      // (ずっと OFF のものを毎回消し直しても画面は変わらないため)。
      clear[key] = prev !== null && prev.layers[key];
      continue;
    }
    const turnedOn = prev !== null && !prev.layers[key];
    const periodHit = periodChanged && PERIOD_DEPENDENT.includes(key);
    fetch[key] = refetchAll || turnedOn || periodHit;
  }

  return { fetch, clear };
}

export interface CoverageCellStep {
  latStep: number;
  lngStep: number;
}

export interface CoverageRenderState {
  step: CoverageCellStep;
  /** その色を描いたときの期間(日数)。 */
  days: number;
}

/**
 * 取得中に「今出ている踏破色」を残してよいか。
 *
 * 残してよいのは**格子の大きさも期間も変わらないとき**だけ。
 *  - 格子は緯度経度の絶対位置に貼り付いているので、大きさが同じなら今出ている色は
 *    その場所の事実のまま(新しい範囲の色が届くまで、少し足りないだけ)。ズームで
 *    粒度が変わると、同じ色が違う面積を意味してしまうので消す。
 *  - 期間が変われば「いつからの踏破か」が変わる。古い期間の色を残すと**選択と
 *    表示が食い違う**(全期間→直近1年の切替で実際に起きる。集計は索引が無いぶん
 *    時間がかかるので、食い違う時間が長い)。
 *  - 次の粒度が読めないときも消す=「古い色を残さない」fail-closed 側に倒す。
 */
export function keepCoverageWhileLoading(
  current: CoverageRenderState | null,
  next: CoverageRenderState | null,
): boolean {
  if (current === null || next === null) return false;
  if (current.days !== next.days) return false;
  return (
    current.step.latStep === next.step.latStep &&
    current.step.lngStep === next.step.lngStep
  );
}
