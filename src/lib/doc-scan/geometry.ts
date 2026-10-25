/**
 * 書類を撮る(第3段)— 紙の四隅の計算(純関数・OpenCV もブラウザも触らない)。
 *
 * 四隅を見つけるのは OpenCV.js(detect.ts)。ここは見つけた点の並べ替え・使えるかの判定・
 * 直したあとの大きさだけを持つ。⚠直したあとの縦横比は**紙そのもの**(向かい合う辺の長いほう)。
 * 枠に合わせて引き伸ばさない。
 */

export interface Point {
  x: number;
  y: number;
}

/** 左上・右上・右下・左下 の順。 */
export type Quad = [Point, Point, Point, Point];

export interface Size {
  width: number;
  height: number;
}

/** 見つけた四角形がこれより小さければ紙とみなさない(画面に対する面積の割合)。 */
export const MIN_QUAD_AREA_RATIO = 0.2;

/** 4点を 左上・右上・右下・左下 に並べる。4点でなければ null。 */
export function orderCorners(points: readonly Point[]): Quad | null {
  if (points.length !== 4) return null;
  // x+y が最小=左上・最大=右下、y-x が最小=右上・最大=左下(傾いた紙でも成り立つ)。
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  const quad: Quad = [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  // 同じ点が2か所に選ばれた(極端に回った紙)ときは、角度で並べ直す。
  if (new Set(quad).size !== 4) return orderByAngle(points);
  return quad;
}

function orderByAngle(points: readonly Point[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  // 画面座標(y は下向き)で時計回り=角度の小さい順。左上(-135°付近)から始める。
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  const start = sorted.reduce((best, p, i) => (p.x + p.y < sorted[best].x + sorted[best].y ? i : best), 0);
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]) as Quad;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** 四角形の面積(靴ひもの公式)。 */
export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 凸で、画面の MIN_QUAD_AREA_RATIO 以上を占める四角形だけを紙として使う。 */
export function isUsableQuad(q: Quad, frame: Size): boolean {
  const signs = [0, 1, 2, 3].map((i) => Math.sign(cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4])));
  if (signs.some((s) => s === 0) || new Set(signs).size !== 1) return false;
  return quadArea(q) >= frame.width * frame.height * MIN_QUAD_AREA_RATIO;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 正面から見た形に直したときの大きさ。`maxEdge` を超えたら縦横比を保って縮める。 */
export function warpedSize(q: Quad, maxEdge?: number): Size {
  const width = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const height = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const scale = maxEdge && Math.max(width, height) > maxEdge ? maxEdge / Math.max(width, height) : 1;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function scaleQuad(q: Quad, factor: number): Quad {
  return q.map((p) => ({ x: p.x * factor, y: p.y * factor })) as Quad;
}

/** 四隅を囲む長方形(整数・画像の内側に収める・幅と高さは 1 以上)。 */
export function quadBounds(q: Quad, frame: Size): { x: number; y: number; width: number; height: number } {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const x0 = Math.floor(clamp(Math.min(...q.map((p) => p.x)), frame.width));
  const y0 = Math.floor(clamp(Math.min(...q.map((p) => p.y)), frame.height));
  const x1 = Math.ceil(clamp(Math.max(...q.map((p) => p.x)), frame.width));
  const y1 = Math.ceil(clamp(Math.max(...q.map((p) => p.y)), frame.height));
  return {
    x: Math.min(x0, frame.width - 1),
    y: Math.min(y0, frame.height - 1),
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

/** 紙が見つからなかったときの枠(画面の内側 5%)。人が角を動かして合わせる。 */
export function defaultQuad(frame: Size): Quad {
  const mx = frame.width * 0.05;
  const my = frame.height * 0.05;
  return [
    { x: mx, y: my },
    { x: frame.width - mx, y: my },
    { x: frame.width - mx, y: frame.height - my },
    { x: mx, y: frame.height - my },
  ];
}
