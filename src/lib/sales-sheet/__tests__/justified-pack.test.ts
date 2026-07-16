import { describe, it, expect } from "vitest";
import { packJustifiedRows } from "../justified-pack";

const W = 167;
const H = 127;
const G = 4;

/** 行分解: y を丸めて同じ行のグループへ(読み順検証用)。 */
function rows(rects: { x: number; y: number; w: number; h: number }[]) {
  const map = new Map<number, typeof rects>();
  for (const r of rects) {
    const key = Math.round(r.y * 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

describe("packJustifiedRows", () => {
  it("空入力は空配列", () => {
    expect(packJustifiedRows([], W, H, G)).toEqual([]);
  });

  it("1枚(横長4:3): 幅いっぱい・比率保存・ゾーン内", () => {
    const a = 4 / 3;
    const [r] = packJustifiedRows([a], W, H, G);
    expect(r.w / r.h).toBeCloseTo(a, 4);
    expect(r.w).toBeCloseTo(W, 3); // 幅フィット(167/1.333=125.3 ≤ H)
    expect(r.y + r.h).toBeLessThanOrEqual(H + 0.01);
  });

  it("1枚(縦長3:4): 高さ超過は等率縮小で H にフィット・比率不変", () => {
    const a = 3 / 4;
    const [r] = packJustifiedRows([a], W, H, G);
    expect(r.w / r.h).toBeCloseTo(a, 4);
    expect(r.h).toBeCloseTo(H, 3); // 幅フィットだと高さ222mm→縮小してH
    expect(r.w).toBeLessThanOrEqual(W + 0.01);
  });

  it("同比3枚: 全rectゾーン内・重なりなし・各行は幅を使い切る", () => {
    const rects = packJustifiedRows([1.5, 1.5, 1.5], W, H, G);
    expect(rects).toHaveLength(3);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-0.01);
      expect(r.y).toBeGreaterThanOrEqual(-0.01);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 0.01);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 0.01);
      expect(r.w / r.h).toBeCloseTo(1.5, 3);
    }
    // 重なりなし
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const overlap =
          a.x + 0.01 < b.x + b.w && b.x + 0.01 < a.x + a.w &&
          a.y + 0.01 < b.y + b.h && b.y + 0.01 < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    // 総高が H を超えて縮小がかかる場合でも各行は幅の7割以上を使う
    for (const row of rows(rects)) {
      const right = Math.max(...row.map((r) => r.x + r.w));
      expect(right).toBeGreaterThan(W * 0.7);
    }
    // 面積の使用率(段組み詰めの狙い): ゾーンの6割以上
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(used / (W * H)).toBeGreaterThan(0.6);
  });

  it("混在比(16:9, 3:4, 4:3, 4:3): 順序保存(読み順)・全てゾーン内・比率保存", () => {
    const aspects = [16 / 9, 3 / 4, 4 / 3, 4 / 3];
    const rects = packJustifiedRows(aspects, W, H, G);
    expect(rects).toHaveLength(4);
    rects.forEach((r, i) => expect(r.w / r.h).toBeCloseTo(aspects[i], 3));
    // 読み順: y は非減少、同一行内で x 増加
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[i - 1], cur = rects[i];
      const sameRow = Math.abs(prev.y - cur.y) < 0.01;
      expect(sameRow ? cur.x > prev.x : cur.y > prev.y).toBe(true);
    }
    for (const r of rects) {
      expect(r.x + r.w).toBeLessThanOrEqual(W + 0.01);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 0.01);
    }
  });

  it("枠内余白ゼロ: 使用面積 = Σ(w×h) が均等グリッド+containより大きい(6枚)", () => {
    // 混在6枚。段組み詰めの写真面積がゾーンの5割を超えること(旧方式は2-4割が死ぬ)。
    const aspects = [16 / 9, 4 / 3, 3 / 4, 4 / 3, 16 / 9, 4 / 3];
    const rects = packJustifiedRows(aspects, W, H, G);
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(used / (W * H)).toBeGreaterThan(0.5);
  });

  it("ゾーン高さが極小でも負/ゼロ寸法を返さない(全rect w>0,h>0)", () => {
    // H=6mm・3枚: k>=2 の分割は行間gap(4mm)だけでHを超え scale が負になり得る構造。
    // 無効な分割はスキップされ、常に正寸法(k=1へフォールバック)であること。
    for (const h of [6, 2, 1]) {
      const rects = packJustifiedRows([1.78, 0.75, 1.33], W, h, G);
      expect(rects).toHaveLength(3);
      for (const r of rects) {
        expect(r.w, `H=${h}`).toBeGreaterThan(0);
        expect(r.h, `H=${h}`).toBeGreaterThan(0);
      }
    }
  });

  it("決定的: 同一入力で同一出力", () => {
    const aspects = [1.78, 0.75, 1.33];
    expect(packJustifiedRows(aspects, W, H, G)).toEqual(packJustifiedRows(aspects, W, H, G));
  });
});
