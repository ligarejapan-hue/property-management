/**
 * mosaic-pack.ts
 *
 * 写真の「モザイク配置」= 順序付きスライシング木（guillotine layout）の全列挙 + 厳密サイズ計算。
 *
 * 段組み詰め(justified-pack)は「写真を行に並べる」パターンしか試さないため、
 * 例えば縦長2枚+横長1枚のような組合せで大きく損をする（縦長が細い1列に潰れる）。
 * こちらは「縦に割る/横に割る」を再帰的に組み合わせた全レイアウトを列挙し、
 * 各レイアウトを厳密に解いて（写真は比率固定なので枠の割り方が決まれば最適サイズは一意）、
 * 一番ゾーンを埋めるものを採用する。切り取りゼロ・比率維持のまま数学的最適解が得られる。
 *
 * ## モデル
 * - 葉 = 写真 i（縦横比 a_i = w/h 固定）。1自由度（スケール）。
 * - V-cut（縦割り=左右に並べ、高さ共有）／ H-cut（横割り=上下に積み、幅共有）。
 * - 各部分木は「幅 = A·h + B」の**線形シェイプ関数**を持つ（A=合成アスペクト・B=gap由来オフセット）:
 *     葉:    A = a_i,                         B = 0
 *     V-cut: A = A_L + A_R,                   B = B_L + B_R + gap
 *     H-cut: A = (A_L·A_R)/(A_L+A_R),         B = A·(B_L/A_L + B_R/A_R − gap)
 * - 根をゾーン(W,H)へ最大内接: h* = min(H, (W−B)/A), w* = A·h* + B（≤W）。
 *
 * ## 探索
 * - **読み順を保つ**ため、連続した写真列 [i,j) を2分割する木のみ列挙する
 *   （in-order 走査＝読み順）。3枚なら 8 パターン、8枚でも約5.5万パターンで数msに収まる。
 * - 木ごとに実レイアウトを計算し、写真占有面積(=充填率)が最大のものを採用。
 * - 非正の枠を生む木は候補外。枚数が上限超・全滅時は justified-pack（段組み）へフォールバック。
 * - 純・決定的・副作用なし。
 */

import { packJustifiedRows, type PackedRect } from "./justified-pack";

/** 全列挙する写真枚数の上限。木の数は枚数に対して超指数的に増えるため打ち切る
 *  （n=8 で約5.5万木・n=9 で約38万木）。超過分は段組み(justified)へフォールバック。 */
const MOSAIC_MAX_N = 8;

type Node =
  | { kind: "leaf"; index: number }
  | { kind: "split"; cut: "V" | "H"; left: Node; right: Node };

/** 部分木の線形シェイプ関数（幅 = A·h + B）。 */
interface Shape {
  a: number;
  b: number;
}

export type { PackedRect };

/**
 * aspects[i] = 写真 i の縦横比(width/height・正数)。
 * 戻り値は同じ順序の枠(ゾーン原点(0,0)基準・mm)。
 */
export function packMosaic(
  aspects: number[],
  W: number,
  H: number,
  gap: number,
): PackedRect[] {
  const n = aspects.length;
  if (n === 0) return [];
  // 非正の比は 4:3 に矯正（ゼロ除算・負寸法の防止）。
  const a = aspects.map((v) => (Number.isFinite(v) && v > 0 ? v : 4 / 3));

  // 枚数が多い場合は全列挙が非現実的なので段組みへフォールバック
  // （多枚数では行配置でも十分に埋まる。モザイクの利得は少枚数の混在比で大きい）。
  if (n > MOSAIC_MAX_N) return packJustifiedRows(aspects, W, H, gap);

  const trees = enumerateTrees(0, n);
  let best: { rects: PackedRect[]; used: number } | null = null;
  for (const tree of trees) {
    const rects = layoutTree(tree, a, W, H, gap);
    if (!rects) continue; // 非正の枠を含む木は不採用
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    // 充填面積が最大の木を採用。同点は列挙順(前寄り=より単純な分割)で安定。
    if (!best || used > best.used + 1e-9) best = { rects, used };
  }
  if (best) return best.rects;
  // 全木が非正（極小ゾーン等）。段組みのフォールバック網に委ねる。
  return packJustifiedRows(aspects, W, H, gap);
}

/**
 * 連続区間 [i, j) の写真を葉に持つ、読み順を保つスライシング木を全列挙する。
 * 各分割点 m と各向き(V/H)の組合せ。部分木はメモ化して重複生成を避ける。
 */
const treeMemo = new Map<string, Node[]>();
function enumerateTrees(i: number, j: number): Node[] {
  if (j - i === 1) return [{ kind: "leaf", index: i }];
  const key = `${i},${j}`;
  const cached = treeMemo.get(key);
  if (cached) return cached;
  const out: Node[] = [];
  for (let m = i + 1; m < j; m++) {
    const lefts = enumerateTrees(i, m);
    const rights = enumerateTrees(m, j);
    for (const left of lefts) {
      for (const right of rights) {
        out.push({ kind: "split", cut: "V", left, right });
        out.push({ kind: "split", cut: "H", left, right });
      }
    }
  }
  treeMemo.set(key, out);
  return out;
}

/** 木のシェイプ関数（幅 = A·h + B）をボトムアップで計算。 */
function shapeOf(node: Node, a: number[], gap: number): Shape {
  if (node.kind === "leaf") return { a: a[node.index], b: 0 };
  const L = shapeOf(node.left, a, gap);
  const R = shapeOf(node.right, a, gap);
  if (node.cut === "V") {
    // 左右に並べ高さ共有: 幅は加算、gap を1つ足す。
    return { a: L.a + R.a, b: L.b + R.b + gap };
  }
  // H-cut: 上下に積み幅共有。A = 調和平均、B は gap 由来オフセット。
  const aNode = (L.a * R.a) / (L.a + R.a);
  const bNode = aNode * (L.b / L.a + R.b / R.a - gap);
  return { a: aNode, b: bNode };
}

/**
 * 木をゾーン(W,H)へ最大内接させ、葉ごとの枠を計算する。
 * 非正の枠が1つでも出れば null（この木は不採用）。戻り値は葉 index 昇順（=入力順）。
 */
function layoutTree(
  node: Node,
  a: number[],
  W: number,
  H: number,
  gap: number,
): PackedRect[] | null {
  const root = shapeOf(node, a, gap);
  if (!(root.a > 0) || !Number.isFinite(root.a) || !Number.isFinite(root.b)) return null;
  // h* = min(H, (W−B)/A) でゾーンに収める。w* = A·h* + B ≤ W。
  const hFromW = (W - root.b) / root.a;
  const h = Math.min(H, hFromW);
  if (!(h > 0)) return null;
  const w = root.a * h + root.b;
  if (!(w > 0) || w > W + 1e-6) return null;

  const rects: PackedRect[] = new Array(a.length);
  const ok = assign(node, a, gap, 0, 0, w, h, rects);
  if (!ok) return null;
  return rects;
}

/**
 * 木を(x,y,w,h)へ割り付け、葉の枠を rects[葉index] に書き込む。
 * シェイプ関数どおりに子の寸法を再構成する（V:幅を分配・H:高さを分配）。
 * 非正寸法が生じたら false。
 */
function assign(
  node: Node,
  a: number[],
  gap: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rects: PackedRect[],
): boolean {
  if (w <= 0 || h <= 0) return false;
  if (node.kind === "leaf") {
    rects[node.index] = { x, y, w, h };
    return true;
  }
  const L = shapeOf(node.left, a, gap);
  const R = shapeOf(node.right, a, gap);
  if (node.cut === "V") {
    // 高さ h 共有。各子の幅 = A·h + B。
    const wl = L.a * h + L.b;
    const wr = R.a * h + R.b;
    if (wl <= 0 || wr <= 0) return false;
    return (
      assign(node.left, a, gap, x, y, wl, h, rects) &&
      assign(node.right, a, gap, x + wl + gap, y, wr, h, rects)
    );
  }
  // H-cut: 幅 w 共有。各子の高さ = (w − B)/A。
  const ht = (w - L.b) / L.a;
  const hb = (w - R.b) / R.a;
  if (ht <= 0 || hb <= 0) return false;
  return (
    assign(node.left, a, gap, x, y, w, ht, rects) &&
    assign(node.right, a, gap, x, y + ht + gap, w, hb, rects)
  );
}
