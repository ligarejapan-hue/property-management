/**
 * 物件から最寄り駅までの徒歩ルート(2026-11-11 発注者指示・資料の演出用の目安)。
 *
 * - 国土地理院ベクトルタイルの道路の線をつないで道のりの網にし、最短の道のりを探す(Dijkstra)。
 * - 駅の位置は同じタイルの注記(label)の「○○駅」の点。査定書の最寄駅の名前に合うものを選ぶ。
 * - 高速道路は歩けないので使わない。タイルの境目でずれた線は 3m 以内ならつながっているとみなす。
 * ⚠目安(実際の道順・横断できる場所は考えない)。資料にもそう書く。座標は物件からのメートル。
 */
import { simplifyLine, type Pt } from "./geo";

export type Station = { name: string; x: number; y: number };

const SNAP_M = 3;
/** 物件・駅から道までこれより遠ければ、道を探さない(地図の外・データの欠け)。 */
const MAX_ACCESS_M = 150;

export const normalizeStationName = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKC")
    .replace(/\s/g, "")
    .replace(/駅$/, "");

/** 査定書の駅名に合う駅(なければ一番近い駅)。遠すぎる(maxM 超)ものは選ばない。 */
export function pickStation(stations: Station[], name: string | null | undefined, maxM = 2000): Station | null {
  const want = normalizeStationName(name);
  const d = (s: Station) => Math.hypot(s.x, s.y);
  const near = stations.filter((s) => d(s) <= maxM).sort((a, b) => d(a) - d(b));
  if (want) {
    const hit = near.find((s) => normalizeStationName(s.name) === want);
    if (hit) return hit;
  }
  return near[0] ?? null;
}

class Heap {
  private a: Array<[number, number]> = [];
  get size() {
    return this.a.length;
  }
  push(v: [number, number]) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** 道の線(メートル座標の折れ線)の網で、from から to までの最短の道のり。見つからなければ null。 */
export function shortestWalk(lines: Pt[][], from: Pt, to: Pt): { path: Pt[]; meters: number } | null {
  const ids = new Map<string, number>();
  const pts: Pt[] = [];
  const adj: Array<Array<[number, number]>> = [];
  const node = (p: Pt) => {
    const k = `${Math.round(p[0])},${Math.round(p[1])}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = pts.length;
      ids.set(k, id);
      pts.push([Math.round(p[0]), Math.round(p[1])]);
      adj.push([]);
    }
    return id;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    const w = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  };
  for (const l of lines) for (let i = 0; i + 1 < l.length; i++) link(node(l[i]), node(l[i + 1]));
  if (pts.length === 0) return null;

  // 物件・駅を、一番近い道の線分の上の点(垂線の足)につなぐ(長い道の途中にいても道に乗れるように・@codex #707)
  const onSeg = new Map<string, number[]>();
  const attach = (q: Pt): number => {
    let best: { a: Pt; b: Pt; f: Pt; d: number } | null = null;
    for (const l of lines)
      for (let i = 0; i + 1 < l.length; i++) {
        const a = l[i];
        const b = l[i + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
        const f: Pt = [a[0] + t * dx, a[1] + t * dy];
        const d = Math.hypot(q[0] - f[0], q[1] - f[1]);
        if (!best || d < best.d) best = { a, b, f, d };
      }
    if (!best || best.d > MAX_ACCESS_M) return -1;
    const id = node(best.f);
    link(id, node(best.a));
    link(id, node(best.b));
    // 物件と駅が同じ線分の上なら、その2点も直につなぐ(線分の端まで回り道しない)
    const key = `${best.a[0]},${best.a[1]},${best.b[0]},${best.b[1]}`;
    for (const other of onSeg.get(key) ?? []) link(id, other);
    onSeg.set(key, [...(onSeg.get(key) ?? []), id]);
    return id;
  };
  const s = attach(from);
  const t = attach(to);
  if (s < 0 || t < 0) return null;

  // タイルの境目などでずれた点を 3m 以内ならつなぐ(格子で近いものだけ比べる)
  const cell = new Map<string, number[]>();
  const ck = (x: number, y: number) => `${Math.floor(x / SNAP_M)},${Math.floor(y / SNAP_M)}`;
  pts.forEach((p, i) => {
    const k = ck(p[0], p[1]);
    (cell.get(k) ?? cell.set(k, []).get(k)!).push(i);
  });
  pts.forEach((p, i) => {
    const cx = Math.floor(p[0] / SNAP_M);
    const cy = Math.floor(p[1] / SNAP_M);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of cell.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j > i && Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]) <= SNAP_M) link(i, j);
        }
  });


  const dist = new Float64Array(pts.length).fill(Infinity);
  const prev = new Int32Array(pts.length).fill(-1);
  dist[s] = 0;
  const h = new Heap();
  h.push([0, s]);
  while (h.size) {
    const [d, u] = h.pop();
    if (d > dist[u]) continue;
    if (u === t) break;
    for (const [v, w] of adj[u]) {
      const nd = d + w;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        h.push([nd, v]);
      }
    }
  }
  if (!Number.isFinite(dist[t])) return null;
  const path: Pt[] = [];
  for (let u = t; u >= 0; u = prev[u]) path.push(pts[u]);
  path.reverse();
  // 道のりには、物件・駅から道までの分も足す(@codex #707)
  const access = Math.hypot(from[0] - pts[s][0], from[1] - pts[s][1]) + Math.hypot(to[0] - pts[t][0], to[1] - pts[t][1]);
  return { path: [from, ...simplifyLine(path, 1.5), to], meters: Math.round(dist[t] + access) };
}
