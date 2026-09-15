import { describe, it, expect } from "vitest";
import { packPhotoCells } from "../layout-engine";

// F5: packPhotoCells の直接テスト(これまでは build-document / editor 経由の
// 間接テストのみだった)。写真ゾーンの実寸(A4横・写真枠)に近い W=124,H=148。
const W = 124;
const H = 148;
const TOL = 1e-6;

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > TOL && overlapH > TOL;
}

describe("packPhotoCells", () => {
  for (let n = 0; n <= 6; n++) {
    describe(`n=${n}`, () => {
      const cells = packPhotoCells(n, W, H);

      it("n 個のセルを返す", () => {
        expect(cells).toHaveLength(n);
      });

      it("すべてのセルが枠 [0,W]×[0,H] の内側に収まる", () => {
        for (const c of cells) {
          expect(c.x).toBeGreaterThanOrEqual(-TOL);
          expect(c.y).toBeGreaterThanOrEqual(-TOL);
          expect(c.x + c.w).toBeLessThanOrEqual(W + TOL);
          expect(c.y + c.h).toBeLessThanOrEqual(H + TOL);
        }
      });

      it("すべてのセルの w/h が正", () => {
        for (const c of cells) {
          expect(c.w).toBeGreaterThan(0);
          expect(c.h).toBeGreaterThan(0);
        }
      });

      it("どのセルどうしも重ならない", () => {
        for (let i = 0; i < cells.length; i++) {
          for (let j = i + 1; j < cells.length; j++) {
            expect(rectsOverlap(cells[i], cells[j])).toBe(false);
          }
        }
      });

      it("決定的(同じ入力→同じ出力)", () => {
        expect(packPhotoCells(n, W, H)).toEqual(cells);
      });
    });
  }

  it("n=0 は空配列", () => {
    expect(packPhotoCells(0, W, H)).toEqual([]);
  });
});
