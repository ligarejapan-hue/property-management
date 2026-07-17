import { describe, expect, it } from "vitest";
import { packMosaic } from "../mosaic-pack";
import type { PackedRect } from "../justified-pack";

/** すべての枠がゾーン [0,W]×[0,H] 内(gap 許容の微小はみ出しなし)。 */
function withinZone(rects: PackedRect[], W: number, H: number): boolean {
  const eps = 1e-6;
  return rects.every(
    (r) =>
      r.x >= -eps &&
      r.y >= -eps &&
      r.x + r.w <= W + eps &&
      r.y + r.h <= H + eps &&
      r.w > 0 &&
      r.h > 0,
  );
}

/** 枠が縦横比(aspect=w/h)を保っているか。 */
function keepsAspect(rects: PackedRect[], aspects: number[]): boolean {
  return rects.every((r, i) => Math.abs(r.w / r.h - aspects[i]) < 1e-3);
}

/** 2枠が重なっていないか(gap があるので接触判定は緩め)。 */
function noOverlap(rects: PackedRect[]): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const sep =
        a.x + a.w <= b.x + 1e-6 ||
        b.x + b.w <= a.x + 1e-6 ||
        a.y + a.h <= b.y + 1e-6 ||
        b.y + b.h <= a.y + 1e-6;
      if (!sep) return false;
    }
  }
  return true;
}

const usedArea = (rects: PackedRect[]) => rects.reduce((s, r) => s + r.w * r.h, 0);

/** 枠列が視覚のラスタ順(上→下・左→右)＝入力 index 順に並んでいるか。 */
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

describe("packMosaic", () => {
  it("空配列は空を返す", () => {
    expect(packMosaic([], 100, 100, 4)).toEqual([]);
  });

  it("1枚は縦横比を保ったままゾーンに最大内接する", () => {
    const rects = packMosaic([3 / 2], 150, 100, 4);
    expect(rects).toHaveLength(1);
    expect(withinZone(rects, 150, 100)).toBe(true);
    expect(keepsAspect(rects, [3 / 2])).toBe(true);
    // aspect 1.5 のゾーン(150x100=1.5)ならぴったり全面。
    expect(rects[0].w).toBeCloseTo(150, 3);
    expect(rects[0].h).toBeCloseTo(100, 3);
  });

  it("入力と同じ順序・同じ枚数の枠を返す", () => {
    const aspects = [1.5, 0.6, 1.2, 0.8];
    const rects = packMosaic(aspects, 177, 150, 4);
    expect(rects).toHaveLength(4);
    expect(keepsAspect(rects, aspects)).toBe(true);
  });

  it("縦長2枚+横長1枚: 切り取りなし・比率維持・重なりなし・ゾーン内", () => {
    // 縦長(aspect<1)2枚 + 横長(aspect>1)1枚 = 段組み(行のみ)が最も損をする組合せ。
    const aspects = [0.66, 0.66, 1.5];
    const W = 177;
    const H = 150;
    const rects = packMosaic(aspects, W, H, 4);
    expect(rects).toHaveLength(3);
    expect(keepsAspect(rects, aspects)).toBe(true);
    expect(withinZone(rects, W, H)).toBe(true);
    expect(noOverlap(rects)).toBe(true);
  });

  it("縦長2枚+横長1枚: モザイク(分割木)は行だけの段組みより無駄が少ない", () => {
    const aspects = [0.66, 0.66, 1.5];
    const W = 177;
    const H = 150;
    const mosaic = packMosaic(aspects, W, H, 4);
    // 参考: 全部を1行に並べる段組み(行のみ)の占有面積。
    // 高さ h の1行: Σ(a_i·h) + (n-1)gap = W → h を解く。
    const sumA = aspects.reduce((s, a) => s + a, 0);
    const rowH = (W - 2 * 4) / sumA;
    const rowArea = aspects.reduce((s, a) => s + a * rowH * rowH, 0);
    expect(usedArea(mosaic)).toBeGreaterThan(rowArea * 1.05);
  });

  it("正方形4枚は 2x2 グリッド相当で高い充填率(ゾーンが正方)", () => {
    const aspects = [1, 1, 1, 1];
    const W = 100;
    const H = 100;
    const rects = packMosaic(aspects, W, H, 4);
    expect(withinZone(rects, W, H)).toBe(true);
    expect(noOverlap(rects)).toBe(true);
    // 2x2: 各枠 (100-4)/2 = 48 の正方形 → 充填 4*48^2 / 10000 = 0.9216
    expect(usedArea(rects) / (W * H)).toBeGreaterThan(0.9);
  });

  it("枚数が上限を超える場合でも比率維持・ゾーン内・重なりなしで返す(フォールバック)", () => {
    const aspects = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 1.4 : 0.7));
    const W = 177;
    const H = 150;
    const rects = packMosaic(aspects, W, H, 4);
    expect(rects).toHaveLength(12);
    expect(withinZone(rects, W, H)).toBe(true);
    expect(keepsAspect(rects, aspects)).toBe(true);
  });

  it("極小ゾーンでも非正の寸法を返さない", () => {
    const rects = packMosaic([1.5, 0.7, 1.2], 6, 6, 4);
    expect(rects.every((r) => r.w > 0 && r.h > 0)).toBe(true);
  });

  it("非有限・非正の縦横比は矯正して破綻しない", () => {
    const rects = packMosaic([0, -1, Number.NaN, Infinity], 100, 100, 4);
    expect(rects).toHaveLength(4);
    expect(rects.every((r) => r.w > 0 && r.h > 0 && Number.isFinite(r.w) && Number.isFinite(r.h))).toBe(
      true,
    );
  });

  it("視覚のラスタ順(上→下・左→右)＝入力順を保つ(@codex #296: 追加写真が上へ飛ばない)", () => {
    // @codex 指摘の例: 極端な縦横比でも、末尾(index 2)が視覚的に先頭へ来ないこと。
    const cases: number[][] = [
      [0.3, 0.3, 1.5],
      [0.66, 0.66, 1.5],
      [1.5, 0.66, 1.2, 0.8],
      [0.7, 0.7, 0.7, 1.5, 1.5],
      [1.5, 0.66, 1.2, 0.75, 1.0, 1.6, 0.9], // n=7(上限)
    ];
    for (const aspects of cases) {
      const rects = packMosaic(aspects, 177, 150, 4);
      expect(isRasterOrdered(rects)).toBe(true);
    }
  });

  it("n=7(上限)でもモザイクが働きラスタ順・ゾーン内・非重複", () => {
    const aspects = [1.5, 0.66, 1.2, 0.75, 1.0, 1.6, 0.9];
    const rects = packMosaic(aspects, 177, 150, 4);
    expect(rects).toHaveLength(7);
    expect(keepsAspect(rects, aspects)).toBe(true);
    expect(withinZone(rects, 177, 150)).toBe(true);
    expect(noOverlap(rects)).toBe(true);
    expect(isRasterOrdered(rects)).toBe(true);
  });

  it("決定的: 同じ入力は同じ出力", () => {
    const aspects = [1.5, 0.66, 1.2, 0.8, 1.0];
    const a = packMosaic(aspects, 177, 150, 4);
    const b = packMosaic(aspects, 177, 150, 4);
    expect(a).toEqual(b);
  });
});
