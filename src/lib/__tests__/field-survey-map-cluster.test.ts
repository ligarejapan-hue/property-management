/**
 * 密集したマーカーのまとめ表示(第3弾・発注者承認 2026-08-24)。
 *
 * 引いて見たときにマーカーが重なって「何件あるのか・どこに固まっているのか」が
 * 分からない問題への対処。外部部品を足さず、**格子でまとめる純関数**にする
 * (この画面のマーカーは React の要素として並べているだけで、地図側の marker
 *  インスタンスを保持していない=外部部品の流儀と噛み合わないため)。
 */
import { describe, it, expect } from "vitest";
import {
  clusterByGrid,
  clusterCellDegrees,
  CLUSTER_MIN_ZOOM,
} from "@/lib/field-survey-map-cluster";

const pt = (id: string, lat: number, lng: number) => ({ id, lat, lng });

describe("clusterCellDegrees: ズームに応じた格子の粗さ", () => {
  it("引くほど格子は粗くなる(単調)", () => {
    const zooms = [10, 12, 14, 16, 18];
    const sizes = zooms.map((z) => clusterCellDegrees(z));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    }
  });

  it("極端なズーム値でも 0 や無限にならない(地図を壊さない)", () => {
    for (const z of [-5, 0, 1, 25, 100, Number.NaN]) {
      const d = clusterCellDegrees(z);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });
});

describe("clusterByGrid: まとめ方", () => {
  it("寄っている(CLUSTER_MIN_ZOOM 以上)ときは1件も束ねない", () => {
    const pts = [pt("a", 35.6, 139.7), pt("b", 35.6, 139.7), pt("c", 35.6, 139.7)];
    const r = clusterByGrid(pts, CLUSTER_MIN_ZOOM);
    expect(r.clusters).toEqual([]);
    expect(r.singles.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("引いているとき、同じ格子に入る複数点は1つにまとまる", () => {
    const pts = [
      pt("a", 35.6000, 139.7000),
      pt("b", 35.6001, 139.7001),
      pt("c", 35.6002, 139.7002),
    ];
    const r = clusterByGrid(pts, 12);
    expect(r.singles).toEqual([]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].count).toBe(3);
    expect(r.clusters[0].ids).toEqual(["a", "b", "c"]);
  });

  it("1点しかない格子はまとめず、そのまま出す(数字の付いた丸にしない)", () => {
    const pts = [pt("a", 35.60, 139.70), pt("b", 36.60, 140.70)];
    const r = clusterByGrid(pts, 12);
    expect(r.clusters).toEqual([]);
    expect(r.singles.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("まとめた印の位置は、その格子に入った点の平均(中心)", () => {
    const pts = [pt("a", 35.0, 139.0), pt("b", 35.0002, 139.0002)];
    const r = clusterByGrid(pts, 12);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].lat).toBeCloseTo(35.0001, 6);
    expect(r.clusters[0].lng).toBeCloseTo(139.0001, 6);
  });

  it("まとめた印には、その中身の id が全部入っている(押したときに使える)", () => {
    const pts = [pt("a", 35.0, 139.0), pt("b", 35.0002, 139.0002)];
    const r = clusterByGrid(pts, 12);
    expect(r.clusters[0].ids.sort()).toEqual(["a", "b"]);
    expect(r.clusters[0].count).toBe(r.clusters[0].ids.length);
  });

  it("入力ゼロ件は空(例外にしない)", () => {
    const r = clusterByGrid([], 12);
    expect(r.clusters).toEqual([]);
    expect(r.singles).toEqual([]);
  });

  it("1件も失わない(まとめた中身+単独=入力件数)。座標が壊れた点は捨てる", () => {
    const pts = [
      pt("a", 35.0, 139.0),
      pt("b", 35.0002, 139.0002),
      pt("c", 40.0, 141.0),
      pt("bad1", Number.NaN, 139.0),
      pt("bad2", 35.0, Number.POSITIVE_INFINITY),
    ];
    const r = clusterByGrid(pts, 12);
    const inClusters = r.clusters.reduce((n, c) => n + c.count, 0);
    expect(inClusters + r.singles.length).toBe(3);
    const ids = [...r.clusters.flatMap((c) => c.ids), ...r.singles.map((s) => s.id)];
    expect(ids).not.toContain("bad1");
    expect(ids).not.toContain("bad2");
  });

  it("同じ入力なら並びも同じ(描き直しのたびに印が入れ替わらない)", () => {
    const pts = [
      pt("c", 35.0, 139.0),
      pt("a", 35.0002, 139.0002),
      pt("b", 40.0, 141.0),
    ];
    const a = clusterByGrid(pts, 12);
    const b = clusterByGrid(pts, 12);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("まとめた印の鍵は中身から決まる(件数だけの鍵にしない=別の場所と衝突しない)", () => {
    const r = clusterByGrid(
      [pt("a", 35.0, 139.0), pt("b", 35.0002, 139.0002), pt("c", 40.0, 141.0), pt("d", 40.0002, 141.0002)],
      12,
    );
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters[0].key).not.toBe(r.clusters[1].key);
  });
});
