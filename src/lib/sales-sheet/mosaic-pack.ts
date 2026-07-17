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

/** 全列挙する写真枚数の上限。木の数は枚数に対して超指数的に増えるため打ち切る。
 *  実測(メモ化後・本リポ): n=7 約12ms / n=8 約85ms。8枚はエディタの state 更新=ブラウザ
 *  メインスレッドで走ると遅い端末で体感 stall になるため 7 で打ち切る(@codex #296 P2)。
 *  モザイクの利得は少枚数の混在比で大きく、8枚以上は段組み(justified)でも十分埋まる。 */
const MOSAIC_MAX_N = 7;

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
  // シェイプ関数(幅=A·h+B)は node ごとに1回だけ計算し、このコール内でメモ化する。
  // node は enumerateTrees の列挙で部分木として共有されるため、全木を通しても各 node の
  // shape 計算は1回で済む(layoutTree/assign が毎回 shapeOf を再帰する O(木サイズ) の
  // 二重計算を除去・@codex #296 P2 の 8枚 150ms を解消)。aspects/gap はコールごとに違うので
  // module-level でなくコールローカルにキャッシュする。
  const shapeCache = new Map<Node, Shape>();
  const shape = (node: Node): Shape => {
    const hit = shapeCache.get(node);
    if (hit) return hit;
    let s: Shape;
    if (node.kind === "leaf") {
      s = { a: a[node.index], b: 0 };
    } else {
      const L = shape(node.left);
      const R = shape(node.right);
      if (node.cut === "V") {
        s = { a: L.a + R.a, b: L.b + R.b + gap };
      } else {
        const an = (L.a * R.a) / (L.a + R.a);
        s = { a: an, b: an * (L.b / L.a + R.b / R.a - gap) };
      }
    }
    shapeCache.set(node, s);
    return s;
  };

  let best: { rects: PackedRect[]; used: number } | null = null;
  for (const tree of trees) {
    const rects = layoutTree(tree, n, shape, W, H, gap);
    if (!rects) continue; // 非正の枠を含む木は不採用
    // 視覚のラスタ順(上→下・左→右)を保つ木だけ採用(@codex #296 P2)。木の in-order は
    // 入力順(=配列順)を保つが、写真の視覚位置までは保証しない。ラスタ順を保つ木に限る
    // ことで、末尾の葉(=autoArrangePhotos の appendedId)が視覚的にも末尾(右下寄り)に来る
    // =追加した写真が左上へ飛ばない。純・決定的なので冪等性も維持。
    if (!isRasterOrdered(rects)) continue;
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    // 充填面積が最大の木を採用。同点は列挙順(前寄り=より単純な分割)で安定。
    if (!best || used > best.used + 1e-9) best = { rects, used };
  }
  if (best) return best.rects;
  // 全木が非正/ラスタ順不成立（極小ゾーン等）。段組みのフォールバック網に委ねる
  // (段組みは常に行=ラスタ順・比率維持なので読み順も保たれる)。
  return packJustifiedRows(aspects, W, H, gap);
}

/**
 * 枠列が視覚のラスタ順(上→下・左→右)＝入力 index 順に並んでいるか。
 * 上端でソート→行クラスタ(次の枠の上端が現在行の最小下端より上なら同じ行)→行内は左端順、で
 * 得た並びが [0,1,…,n−1] と一致するかを見る。高さ違いの同一行でも破綻しない判定。
 */
function isRasterOrdered(rects: PackedRect[]): boolean {
  const items = rects.map((r, i) => ({ i, y: r.y, bottom: r.y + r.h, x: r.x }));
  items.sort((p, q) => p.y - q.y || p.x - q.x || p.i - q.i);
  const rows: { minBottom: number; items: typeof items }[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && it.y < row.minBottom - 0.01) {
      row.items.push(it);
      row.minBottom = Math.min(row.minBottom, it.bottom);
    } else {
      rows.push({ minBottom: it.bottom, items: [it] });
    }
  }
  let expect = 0;
  for (const row of rows) {
    row.items.sort((p, q) => p.x - q.x || p.i - q.i);
    for (const it of row.items) {
      if (it.i !== expect) return false;
      expect++;
    }
  }
  return true;
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

/** メモ化済みのシェイプ関数(node→幅=A·h+B)。 */
type ShapeFn = (node: Node) => Shape;

/**
 * 木をゾーン(W,H)へ最大内接させ、葉ごとの枠を計算する。
 * 非正の枠が1つでも出れば null（この木は不採用）。戻り値は葉 index 昇順（=入力順）。
 */
function layoutTree(
  node: Node,
  n: number,
  shape: ShapeFn,
  W: number,
  H: number,
  gap: number,
): PackedRect[] | null {
  const root = shape(node);
  if (!(root.a > 0) || !Number.isFinite(root.a) || !Number.isFinite(root.b)) return null;
  // h* = min(H, (W−B)/A) でゾーンに収める。w* = A·h* + B ≤ W。
  const hFromW = (W - root.b) / root.a;
  const h = Math.min(H, hFromW);
  if (!(h > 0)) return null;
  const w = root.a * h + root.b;
  if (!(w > 0) || w > W + 1e-6) return null;

  const rects: PackedRect[] = new Array(n);
  const ok = assign(node, shape, gap, 0, 0, w, h, rects);
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
  shape: ShapeFn,
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
  const L = shape(node.left);
  const R = shape(node.right);
  if (node.cut === "V") {
    // 高さ h 共有。各子の幅 = A·h + B。
    const wl = L.a * h + L.b;
    const wr = R.a * h + R.b;
    if (wl <= 0 || wr <= 0) return false;
    return (
      assign(node.left, shape, gap, x, y, wl, h, rects) &&
      assign(node.right, shape, gap, x + wl + gap, y, wr, h, rects)
    );
  }
  // H-cut: 幅 w 共有。各子の高さ = (w − B)/A。
  const ht = (w - L.b) / L.a;
  const hb = (w - R.b) / R.a;
  if (ht <= 0 || hb <= 0) return false;
  return (
    assign(node.left, shape, gap, x, y, w, ht, rects) &&
    assign(node.right, shape, gap, x, y + ht + gap, w, hb, rects)
  );
}
