/**
 * 密集したマーカーを格子でまとめる(第3弾・発注者承認 2026-08-24)。
 *
 * 引いて見たときマーカーが重なり、何件あるのか・どこに固まっているのかが
 * 分からなくなる問題への対処。
 *
 * ⚠外部部品(markerclusterer 系)を足していない。この画面のマーカーは React の
 *   要素として宣言的に並べているだけで、地図側の marker インスタンスを保持して
 *   いない(面と線だけが地図へ直接貼る方式)。外部部品は marker インスタンスを
 *   自分で持つ流儀なので噛み合わず、focusPin の強調マーカーや撮影タップ待ちの
 *   クリック無効化とも干渉する。格子でまとめるだけなら**純関数**で書けて、
 *   総当たりで検証でき、既存の描画経路をそのまま使える。
 */

/** この倍率まで寄っていたら、まとめずに1つずつ出す(建物が見える倍率)。 */
export const CLUSTER_MIN_ZOOM = 16;

export interface ClusterPoint {
  id: string;
  lat: number;
  lng: number;
  /**
   * この点が「済み」か(対応済みのピン / 売却済み・終了の物件)。
   * 省略は**未対応**として扱う=見落とさない側へ倒す。
   */
  done?: boolean;
}

export interface MarkerCluster {
  /** 描き直しで印が入れ替わらないための鍵(中身から決まる)。 */
  key: string;
  lat: number;
  lng: number;
  count: number;
  ids: string[];
  /**
   * 中身が**全部済み**か(@codex #409 R5 P2)。1件でも未対応が混ざれば false。
   * まとまりを現役の色で出すと、終わった場所へ人を送ることになるため、
   * 見た目をここから決める。
   */
  allDone: boolean;
}

export interface ClusterResult {
  clusters: MarkerCluster[];
  /** まとめなかった点(そのまま元のマーカーとして描く)。 */
  singles: ClusterPoint[];
}

/**
 * ズーム倍率 → 格子の一辺(度)。
 * 引くほど粗く。倍率が1上がるごとに実際の縮尺は2倍になるので、それに合わせる。
 * 値が壊れていても地図を壊さないよう、上下で必ず有限の正数に収める。
 */
export function clusterCellDegrees(zoom: number): number {
  const z = Number.isFinite(zoom) ? zoom : CLUSTER_MIN_ZOOM;
  const clamped = Math.min(22, Math.max(1, z));
  // z=16 で約 0.0006 度(およそ 60m 四方)を基準に、1段引くごとに倍。
  return 0.0006 * Math.pow(2, CLUSTER_MIN_ZOOM - clamped);
}

const isFiniteCoord = (v: number) => typeof v === "number" && Number.isFinite(v);

export function clusterByGrid(
  points: readonly ClusterPoint[],
  zoom: number,
): ClusterResult {
  const usable = points.filter((p) => isFiniteCoord(p.lat) && isFiniteCoord(p.lng));

  // 寄っているときは束ねない(1件ずつ見えている状態を邪魔しない)。
  if (Number.isFinite(zoom) && zoom >= CLUSTER_MIN_ZOOM) {
    return { clusters: [], singles: [...usable] };
  }

  const cell = clusterCellDegrees(zoom);
  // 入力順を保つ Map(同じ入力なら同じ並び=描き直しで印が入れ替わらない)。
  const buckets = new Map<string, ClusterPoint[]>();
  for (const p of usable) {
    const y = Math.floor(p.lat / cell);
    const x = Math.floor(p.lng / cell);
    const key = `${y}:${x}`;
    const found = buckets.get(key);
    if (found) found.push(p);
    else buckets.set(key, [p]);
  }

  const clusters: MarkerCluster[] = [];
  const singles: ClusterPoint[] = [];
  for (const [, members] of buckets) {
    if (members.length === 1) {
      singles.push(members[0]);
      continue;
    }
    let latSum = 0;
    let lngSum = 0;
    for (const m of members) {
      latSum += m.lat;
      lngSum += m.lng;
    }
    const ids = members.map((m) => m.id);
    clusters.push({
      // 鍵は中身から作る。件数だけだと別の場所のまとまりと衝突する。
      key: `c:${ids.join(",")}`,
      lat: latSum / members.length,
      lng: lngSum / members.length,
      count: members.length,
      ids,
      // 未指定(done 省略)は未対応扱い=1件でもあれば現役の色で出す。
      allDone: members.every((m) => m.done === true),
    });
  }

  return { clusters, singles };
}
