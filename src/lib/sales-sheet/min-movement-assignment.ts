/**
 * min-movement-assignment.ts
 *
 * 写真の現在位置を、整列後のスロット群へ「総移動距離が最小」になるよう割り当てる純関数。
 * 「写真を自動整列」で追加順に詰め直すのではなく、ボタンを押した時点の各写真位置に
 * 最も近いスロットへ割り当てることで、ユーザーが作った並びを保ちつつ整列する。
 *
 * 割当は線形割当問題（LAP）。Hungarian（Kuhn–Munkres, O(n^3)）で厳密最適を解く。
 * 純・決定的（同点は添字順で解決）。副作用なし・crypto/乱数なし。
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * n×n のコスト行列に対する最小コスト割当（Hungarian, 1-indexed 実装）。
 * 返り値 rowToCol[i] = 行 i に割り当てられた列 j。
 * 参考: 競技プログラミングで定番の potential + augmenting path 版。
 */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const INF = Number.POSITIVE_INFINITY;
  // u/v: potentials, p[j]: 列 j に割り当てられた行（1-indexed・p[0]は作業用）, way[j]: 復元用。
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(INF);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // 交互路に沿って割当を復元。
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) rowToCol[p[j] - 1] = j - 1;
  }
  return rowToCol;
}

/**
 * 各写真中心を、総移動距離（ユークリッド）が最小になるようスロット中心へ割り当てる。
 * @param photoCenters 各写真の現在中心（長さ n）
 * @param slotCenters  整列先スロットの中心（長さ n・photoCenters と同数）
 * @param unpositionedRows 現在位置が未確定な写真の index 集合（省略可）。ここに含む写真は
 *   距離項を無視（＝どのスロットへも等コスト）し、既存の位置が確定した写真の割当を乱さない。
 *   追加直後にページ中央へ仮置きされた写真が、既存の代表写真からスロットを奪うのを防ぐ用途。
 *   未確定写真は余ったスロットを埋め、複数あるときは入力順（末尾側）へ tie-break で寄る。
 * @returns assignment[photoIndex] = 割り当てられた slotIndex（順列）
 */
export function assignMinMovement(
  photoCenters: Point[],
  slotCenters: Point[],
  unpositionedRows?: ReadonlySet<number>,
): number[] {
  const n = photoCenters.length;
  if (n === 0) return [];
  if (slotCenters.length !== n) {
    throw new Error(
      `assignMinMovement: photoCenters(${n}) と slotCenters(${slotCenters.length}) は同数である必要があります`,
    );
  }
  if (n === 1) return [0];

  // コスト＝移動距離（主）＋ごく小さな tie-break（従）。距離が同点のときは入力順
  // （写真 k → スロット k）を優先＝新規追加で全写真が同一点に積み重なった degenerate な
  // 場合でも「先頭写真＝代表写真が先頭スロット」に決定的に収まる。EPS は mm スケールの
  // 実距離差より十分小さく（|i−j|≤n の摂動が最大でも EPS·n）、真の最小移動解を変えない。
  // unpositionedRows の写真は距離項をゼロにする＝既存写真の最小移動割当を優先させ、
  // その写真自身は残ったスロット（tie-break で末尾寄り）に収める。
  const EPS = 1e-6;
  const cost: number[][] = photoCenters.map((p, i) => {
    const free = unpositionedRows?.has(i) ?? false;
    return slotCenters.map((s, j) => {
      const distance = free ? 0 : Math.hypot(p.x - s.x, p.y - s.y);
      return distance + EPS * Math.abs(i - j);
    });
  });
  return hungarian(cost);
}
