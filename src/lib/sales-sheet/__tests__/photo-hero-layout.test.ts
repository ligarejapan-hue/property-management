/**
 * photo-hero-layout.test.ts — 販売図面 第②段「主役1枚+残りは全部同じ大きさ」の並べ方。
 *
 * 発注者判断(2026-09-16):
 *   - 主役を写真枠の上に大きく1枚、残りはその下に**全部同じ大きさ**で並べる
 *   - 主役が無ければ全部同じ大きさ
 *   - 写真は切らずに全体を見せる(fit:contain)=並べ方は写真の縦横に左右されない
 *   - 「写真を自動整列」は大きさを保って位置だけ詰める(repackKeepingSizes)
 */
import { describe, it, expect } from "vitest";
import {
  heroGridCells,
  repackKeepingSizes,
  HERO_HEIGHT_RATIO,
  PHOTO_GAP_MM,
  CONSUMER_PHOTO_ZONE,
  type PhotoCell,
} from "../layout-engine";

const W = CONSUMER_PHOTO_ZONE.w;
const H = CONSUMER_PHOTO_ZONE.h;
const EPS = 1e-6;

function overlaps(a: PhotoCell, b: PhotoCell): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}
function insideZone(c: PhotoCell): boolean {
  return c.x >= -EPS && c.y >= -EPS && c.x + c.w <= W + EPS && c.y + c.h <= H + EPS && c.w > 0 && c.h > 0;
}
function assertNoOverlapInside(cells: PhotoCell[]): void {
  cells.forEach((c) => expect(insideZone(c), JSON.stringify(c)).toBe(true));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      expect(overlaps(cells[i], cells[j]), `${i} と ${j} が重なる`).toBe(false);
    }
  }
}

describe("heroGridCells — 主役1枚+残りは同じ大きさ", () => {
  it("0枚なら空", () => {
    expect(heroGridCells(0, null, W, H)).toEqual([]);
  });

  it("1枚は主役の有無にかかわらず写真枠いっぱい", () => {
    expect(heroGridCells(1, null, W, H)).toEqual([{ x: 0, y: 0, w: W, h: H }]);
    expect(heroGridCells(1, 0, W, H)).toEqual([{ x: 0, y: 0, w: W, h: H }]);
  });

  it("主役は上に横幅いっぱい・高さは (H-間隔)×比率", () => {
    const cells = heroGridCells(4, 0, W, H);
    const heroH = (H - PHOTO_GAP_MM) * HERO_HEIGHT_RATIO;
    expect(cells[0].x).toBeCloseTo(0);
    expect(cells[0].y).toBeCloseTo(0);
    expect(cells[0].w).toBeCloseTo(W);
    expect(cells[0].h).toBeCloseTo(heroH);
  });

  it("主役以外は主役の下に並ぶ", () => {
    const cells = heroGridCells(4, 0, W, H);
    const heroBottom = cells[0].y + cells[0].h;
    cells.slice(1).forEach((c) => expect(c.y).toBeGreaterThanOrEqual(heroBottom + PHOTO_GAP_MM - EPS));
  });

  it("主役は配列の何番目でも指定できる(指定した要素が大きい)", () => {
    const cells = heroGridCells(4, 2, W, H);
    expect(cells[2].w).toBeCloseTo(W);
    expect(cells[2].y).toBeCloseTo(0);
    [0, 1, 3].forEach((i) => expect(cells[i].w).toBeLessThan(W));
  });

  it("主役以外は枚数によらず全部同じ大きさ(2〜8枚)", () => {
    for (let n = 2; n <= 8; n++) {
      const rest = heroGridCells(n, 0, W, H).slice(1);
      rest.forEach((c) => {
        expect(c.w, `n=${n}`).toBeCloseTo(rest[0].w);
        expect(c.h, `n=${n}`).toBeCloseTo(rest[0].h);
      });
    }
  });

  it("主役が無ければ全部同じ大きさ(1〜8枚)", () => {
    for (let n = 1; n <= 8; n++) {
      const cells = heroGridCells(n, null, W, H);
      cells.forEach((c) => {
        expect(c.w, `n=${n}`).toBeCloseTo(cells[0].w);
        expect(c.h, `n=${n}`).toBeCloseTo(cells[0].h);
      });
    }
  });

  it("どの枚数・主役位置でも重ならず写真枠からはみ出さない", () => {
    for (let n = 1; n <= 8; n++) {
      for (const hero of [null, 0, n - 1]) {
        const cells = heroGridCells(n, hero, W, H);
        expect(cells).toHaveLength(n);
        assertNoOverlapInside(cells);
      }
    }
  });

  it("範囲外の主役番号は「主役なし」として扱う", () => {
    expect(heroGridCells(3, 5, W, H)).toEqual(heroGridCells(3, null, W, H));
    expect(heroGridCells(3, -1, W, H)).toEqual(heroGridCells(3, null, W, H));
  });

  it("4枚・主役なしは2×2(横長の写真に近い形を選ぶ)", () => {
    const cells = heroGridCells(4, null, W, H);
    const ys = new Set(cells.map((c) => Math.round(c.y * 1000)));
    const xs = new Set(cells.map((c) => Math.round(c.x * 1000)));
    expect(ys.size).toBe(2);
    expect(xs.size).toBe(2);
  });

  it("決定的(同じ入力なら同じ結果)", () => {
    expect(heroGridCells(5, 1, W, H)).toEqual(heroGridCells(5, 1, W, H));
  });
});

describe("repackKeepingSizes — 大きさを保って位置だけ詰める", () => {
  it("入りきるなら大きさは1mmも変えない", () => {
    const sizes = [
      { w: 80, h: 60 },
      { w: 40, h: 30 },
      { w: 40, h: 30 },
    ];
    const cells = repackKeepingSizes(sizes, null, W, H);
    cells.forEach((c, i) => {
      expect(c.w).toBeCloseTo(sizes[i].w);
      expect(c.h).toBeCloseTo(sizes[i].h);
    });
    assertNoOverlapInside(cells);
  });

  it("主役を先頭(左上)に置き、残りは配列順", () => {
    const sizes = [
      { w: 40, h: 30 },
      { w: 100, h: 70 },
      { w: 40, h: 30 },
    ];
    const cells = repackKeepingSizes(sizes, 1, W, H);
    expect(cells[1].x).toBeCloseTo(0);
    expect(cells[1].y).toBeCloseTo(0);
    assertNoOverlapInside(cells);
  });

  it("入りきらなければ全部を同じ割合で縮めて収める(大きさの比は保つ)", () => {
    const sizes = [
      { w: 120, h: 90 },
      { w: 120, h: 90 },
      { w: 120, h: 90 },
    ];
    const cells = repackKeepingSizes(sizes, null, W, H);
    assertNoOverlapInside(cells);
    const ratio = cells[0].w / sizes[0].w;
    expect(ratio).toBeLessThan(1);
    cells.forEach((c, i) => {
      expect(c.w / sizes[i].w).toBeCloseTo(ratio, 5);
      expect(c.h / sizes[i].h).toBeCloseTo(ratio, 5);
    });
  });

  it("枠より横に広い1枚は縦横比を保って枠の幅に収める", () => {
    const cells = repackKeepingSizes([{ w: 200, h: 100 }], null, W, H);
    expect(cells[0].w).toBeCloseTo(W);
    expect(cells[0].h).toBeCloseTo(W / 2);
    assertNoOverlapInside(cells);
  });

  it("0枚なら空", () => {
    expect(repackKeepingSizes([], null, W, H)).toEqual([]);
  });

  it("手で大きくした1枚を含む混在でも重ならない(1〜8枚)", () => {
    for (let n = 1; n <= 8; n++) {
      const sizes = Array.from({ length: n }, (_, i) => (i === 0 ? { w: 110, h: 80 } : { w: 38, h: 28 }));
      assertNoOverlapInside(repackKeepingSizes(sizes, 0, W, H));
    }
  });
});

// @codex #433 P2: 棚詰めは縮小率によって行の区切りが変わるため、「入りきるか」は縮小率に
// 対して単調ではない。二分探索だと必要以上に縮める(下の例: 0.96 で入るのに約 0.847)。
describe("repackKeepingSizes — 必要以上に縮めない(行の区切りが変わる場合)", () => {
  /** 結果の縮小率(1枚目の幅の比)。 */
  const scaleOf = (cells: PhotoCell[], sizes: { w: number; h: number }[]) => cells[0].w / sizes[0].w;

  /** 細かく刻んで全部試したときの「入りきる最大の縮小率」(照合用・遅くてよい)。 */
  function bruteForceMaxScale(sizes: { w: number; h: number }[], heroIndex: number | null): number {
    for (let k = 10000; k >= 1; k--) {
      const s = k / 10000;
      const scaled = sizes.map((z) => ({ w: z.w * s, h: z.h * s }));
      const cells = repackKeepingSizes(scaled, heroIndex, W, H);
      // 縮めなくても入る=その縮小率で入りきる
      if (cells.every((c, i) => Math.abs(c.w - scaled[i].w) < 1e-9 && Math.abs(c.h - scaled[i].h) < 1e-9)) return s;
    }
    return 0;
  }

  it("指摘の例: 40×30 / 90×50 / 30×120 は 0.96 倍で収まる(0.847 まで縮めない)", () => {
    const sizes = [
      { w: 40, h: 30 },
      { w: 90, h: 50 },
      { w: 30, h: 120 },
    ];
    const cells = repackKeepingSizes(sizes, null, W, H);
    expect(scaleOf(cells, sizes)).toBeCloseTo(0.96, 6);
    assertNoOverlapInside(cells);
  });

  it("総当たりの最大値と一致する(大きさの組み合わせ多数)", () => {
    // 決定的な擬似乱数で大きさの組み合わせを作る
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let t = 0; t < 40; t++) {
      const n = 2 + Math.floor(rand() * 5);
      const sizes = Array.from({ length: n }, () => ({ w: 20 + rand() * 100, h: 20 + rand() * 120 }));
      const hero = rand() < 0.5 ? null : Math.floor(rand() * n);
      const cells = repackKeepingSizes(sizes, hero, W, H);
      assertNoOverlapInside(cells);
      const got = scaleOf(cells, sizes);
      const best = Math.min(1, bruteForceMaxScale(sizes, hero));
      expect(got, `case ${t} n=${n} hero=${hero}`).toBeGreaterThanOrEqual(best - 1e-9);
    }
  });
});
