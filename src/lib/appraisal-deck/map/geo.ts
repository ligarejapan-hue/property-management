/**
 * 「査定のご報告」の周辺地図(2026-11-11)の座標の計算。
 *
 * 物件の位置を原点(0,0)にした平面のメートル座標(x=東, y=北)で扱う。
 * ⚠地図のデータには緯度経度を入れない(物件からの相対のメートルだけ)。
 */
export type Pt = [number, number];

export const TILE_ZOOM = 16;
export const TILE_EXTENT_DEFAULT = 4096;

/** 経度・緯度 → タイル座標(小数つき)。 */
export function lonLatToTile(lon: number, lat: number, z = TILE_ZOOM): Pt {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}

/** タイル座標(小数つき) → 経度・緯度。 */
export function tileToLonLat(tx: number, ty: number, z = TILE_ZOOM): Pt {
  const n = 2 ** z;
  const lon = (tx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lon, lat];
}

const M_PER_DEG_LAT = 110_940;
const M_PER_DEG_LON_EQ = 111_319.49;

/** 原点(物件)からのメートル座標へ。狭い範囲(数km)用の近似。 */
export function makeLocalProjection(lon0: number, lat0: number) {
  const mx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  return {
    toLocal: (lon: number, lat: number): Pt => [(lon - lon0) * mx, (lat - lat0) * M_PER_DEG_LAT],
    toLonLat: (x: number, y: number): Pt => [lon0 + x / mx, lat0 + y / M_PER_DEG_LAT],
  };
}

/** 原点から東西 ±ex m・南北 ±ey m を覆うタイル(z16)の一覧。 */
export function tilesCovering(lon0: number, lat0: number, ex: number, ey: number, z = TILE_ZOOM): Array<[number, number]> {
  const p = makeLocalProjection(lon0, lat0);
  const [lo1, la1] = p.toLonLat(-ex, -ey);
  const [lo2, la2] = p.toLonLat(ex, ey);
  const [x1, y1] = lonLatToTile(lo1, la2, z);
  const [x2, y2] = lonLatToTile(lo2, la1, z);
  const out: Array<[number, number]> = [];
  for (let x = Math.floor(x1); x <= Math.floor(x2); x++) for (let y = Math.floor(y1); y <= Math.floor(y2); y++) out.push([x, y]);
  return out;
}

/** 多角形の面積(反時計回りで正)。 */
export function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 多角形を軸に平行な長方形で切る(Sutherland–Hodgman)。閉じ点は持たない形で返す。 */
export function clipPolygonToRect(ring: Pt[], minX: number, minY: number, maxX: number, maxY: number): Pt[] {
  type Edge = { inside: (p: Pt) => boolean; cut: (a: Pt, b: Pt) => Pt };
  const lerpX = (a: Pt, b: Pt, x: number): Pt => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const lerpY = (a: Pt, b: Pt, y: number): Pt => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  const edges: Edge[] = [
    { inside: (p) => p[0] >= minX, cut: (a, b) => lerpX(a, b, minX) },
    { inside: (p) => p[0] <= maxX, cut: (a, b) => lerpX(a, b, maxX) },
    { inside: (p) => p[1] >= minY, cut: (a, b) => lerpY(a, b, minY) },
    { inside: (p) => p[1] <= maxY, cut: (a, b) => lerpY(a, b, maxY) },
  ];
  let out = dropClosing(ring);
  for (const e of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const ci = e.inside(cur);
      const pi = e.inside(prev);
      if (ci) {
        if (!pi) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(e.cut(prev, cur));
      }
    }
  }
  return out;
}

/** 折れ線を長方形で切る(はみ出た所で分ける)。 */
export function clipLineToRect(line: Pt[], minX: number, minY: number, maxX: number, maxY: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i], line[i + 1], minX, minY, maxX, maxY);
    if (!seg) {
      flush();
      continue;
    }
    const [a, b] = seg;
    const last = cur[cur.length - 1];
    if (!last || last[0] !== a[0] || last[1] !== a[1]) {
      flush();
      cur.push(a);
    }
    cur.push(b);
    // 線分の終わりが切られていたら、そこで折れ線も切れる。
    if (b[0] !== line[i + 1][0] || b[1] !== line[i + 1][1]) flush();
  }
  flush();
  return out;
}

/** 線分を長方形で切る(Liang–Barsky)。外なら null。 */
function clipSegment(a: Pt, b: Pt, minX: number, minY: number, maxX: number, maxY: number): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: Array<[number, number]> = [
    [-dx, a[0] - minX],
    [dx, maxX - a[0]],
    [-dy, a[1] - minY],
    [dy, maxY - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [
    t0 === 0 ? a : [a[0] + t0 * dx, a[1] + t0 * dy],
    t1 === 1 ? b : [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** 点を間引く(Douglas–Peucker)。端の2点は残す。 */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1;
    let bi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol && bi > 0) {
      keep[bi] = 1;
      stack.push([s, bi], [bi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 閉じた多角形を間引く(2つに割って間引き、つなぐ)。 */
export function simplifyRing(ring: Pt[], tol: number): Pt[] {
  const r = dropClosing(ring);
  if (r.length <= 4) return r;
  const mid = Math.floor(r.length / 2);
  const a = simplifyLine(r.slice(0, mid + 1), tol);
  const b = simplifyLine([...r.slice(mid), r[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点から多角形までの距離(中なら 0)。 */
export function distToRing(p: Pt, ring: Pt[]): number {
  if (pointInRing(p, ring)) return 0;
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

function dropClosing(ring: Pt[]): Pt[] {
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring.slice();
}

/** 0.5m 単位の差分の並びにする(資料に入れる軽い形)。 */
export function encodeDelta(pts: Pt[]): number[] {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of pts) {
    const X = Math.round(x * 2);
    const Y = Math.round(y * 2);
    if (out.length && X === px && Y === py) continue;
    out.push(X - px, Y - py);
    px = X;
    py = Y;
  }
  return out;
}

/** 0〜1 の決まった乱数(同じ番号なら同じ値=作り直しても同じ街になる)。 */
export function seededRandom(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
