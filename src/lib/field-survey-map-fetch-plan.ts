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
  /**
   * 画面へ戻ってきた合図。増えたら軽い層(ピン・物件)を取り直す。
   * ⚠踏破の面と軌跡の線は**全社合計**で、同僚が巡回を終えれば内容が変わる
   * (発注者決定 2026-07-28「誰の分かを区別しない」)。放っておくと二度歩きを
   * 防ぐという機能の目的が崩れるため、復帰でも取り直す。ただし写真のたびに
   * 戻ってくる使い方で重い集計を繰り返さないよう、頻度に下限を置く
   * (shouldRefreshHeavyOnResume)。下限を越えた復帰は refetchNonce 側で
   * 全層を取り直す。
   */
  resumeNonce: number;
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

/** 復帰時に取り直す層。他の担当者が増やせるのはピンと物件だけ。 */
const RESUME_DEPENDENT: readonly MapLayerKey[] = ["properties", "pins"];

export function planMapFetch(
  prev: MapFetchInputs | null,
  next: MapFetchInputs,
  /**
   * **まだ画面に反映できていない層**(取りに行ったが中断された/失敗した)。
   * ⚠これが無いと、取得中にレイヤーや期間を切り替えたときに取りこぼす
   * (@codex #409 R2 P2)。前回の計画が「取った」と記録した直後に中断されると、
   * 次の差分計画はその層を「もう持っている」と見なして取りに行かず、地図が
   * 空のまま/古いまま残る(地図を動かすか更新を押すまで直らない)。
   */
  pending: ReadonlySet<MapLayerKey> = new Set(),
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
  const resumed = prev !== null && prev.resumeNonce !== next.resumeNonce;

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
    const resumeHit = resumed && RESUME_DEPENDENT.includes(key);
    // 未達の層は、他に理由が無くても取り直す(取りこぼしの自己修復)。
    fetch[key] =
      refetchAll || turnedOn || periodHit || resumeHit || pending.has(key);
  }

  return { fetch, clear };
}

/**
 * 復帰時に重い層(踏破の面・軌跡の線)まで取り直す最短間隔。
 * 撮影のたびにカメラから戻る使い方で、索引の無い集計を繰り返さないための下限。
 */
export const RESUME_HEAVY_MIN_INTERVAL_MS = 3 * 60 * 1000;

/**
 * 画面へ戻ったとき、重い層まで取り直すか(@codex #409 R6 P2)。
 * 判断できないとき(時刻が読めない・時計が巻き戻った)は**取る側**へ倒す
 * =古い踏破色を出し続けない。
 */
export function shouldRefreshHeavyOnResume(
  nowMs: number,
  lastHeavyFetchAtMs: number,
  minIntervalMs: number = RESUME_HEAVY_MIN_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastHeavyFetchAtMs)) return true;
  // 0 = まだ一度も取っていない(初期値)。無条件で取る。
  if (lastHeavyFetchAtMs <= 0) return true;
  const elapsed = nowMs - lastHeavyFetchAtMs;
  if (elapsed < 0) return true; // 時計が巻き戻った
  return elapsed >= minIntervalMs;
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
