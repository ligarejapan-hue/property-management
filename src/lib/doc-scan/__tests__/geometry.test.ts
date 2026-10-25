import { describe, expect, it } from "vitest";
import {
  defaultQuad,
  quadBounds,
  isUsableQuad,
  orderCorners,
  scaleQuad,
  warpedSize,
  type Quad,
} from "../geometry";

const square: Quad = [
  { x: 10, y: 10 },
  { x: 110, y: 10 },
  { x: 110, y: 210 },
  { x: 10, y: 210 },
];

describe("orderCorners", () => {
  it("どの順で来ても 左上・右上・右下・左下 に並べる", () => {
    const shuffled = [square[2], square[0], square[3], square[1]];
    expect(orderCorners(shuffled)).toEqual(square);
  });

  it("傾いた紙でも左上から時計回り", () => {
    const tilted = [
      { x: 300, y: 96 },
      { x: 38, y: 430 },
      { x: 62, y: 74 },
      { x: 318, y: 452 },
    ];
    expect(orderCorners(tilted)).toEqual([
      { x: 62, y: 74 },
      { x: 300, y: 96 },
      { x: 318, y: 452 },
      { x: 38, y: 430 },
    ]);
  });

  it("4点でなければ null", () => {
    expect(orderCorners(square.slice(0, 3))).toBeNull();
  });
});

describe("isUsableQuad", () => {
  it("画面の2割以上を占める凸の四角形は使う", () => {
    expect(isUsableQuad(square, { width: 120, height: 220 })).toBe(true);
  });

  it("小さすぎる四角形(机の上の別の紙・名刺など)は使わない", () => {
    expect(isUsableQuad(square, { width: 1000, height: 1000 })).toBe(false);
  });

  it("ねじれた(交差する)四角形は使わない", () => {
    const twisted: Quad = [square[0], square[2], square[1], square[3]];
    expect(isUsableQuad(twisted, { width: 120, height: 220 })).toBe(false);
  });
});

describe("warpedSize", () => {
  it("向かい合う辺の長いほうを幅・高さにする(紙そのものの縦横比)", () => {
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 120, y: 150 },
      { x: -20, y: 150 },
    ];
    // 上辺 100・下辺 140 → 幅 140。左右の辺はどちらも √(20²+150²)≈151.3 → 高さ 151。
    expect(warpedSize(quad)).toEqual({ width: 140, height: 151 });
  });

  it("長い辺の上限を超えたら縦横比を保って縮める", () => {
    expect(warpedSize(square, 100)).toEqual({ width: 50, height: 100 });
  });
});

describe("scaleQuad", () => {
  it("下見の小さい画像で見つけた角を元の大きさに戻す", () => {
    expect(scaleQuad(square, 2)).toEqual([
      { x: 20, y: 20 },
      { x: 220, y: 20 },
      { x: 220, y: 420 },
      { x: 20, y: 420 },
    ]);
  });
});

describe("quadBounds", () => {
  it("四隅を囲む長方形(部品が読めなかったときの切り取り)", () => {
    expect(quadBounds(square, { width: 300, height: 300 })).toEqual({ x: 10, y: 10, width: 100, height: 200 });
  });

  it("画像の外にはみ出した角は内側に収める", () => {
    const out: Quad = [
      { x: -5, y: -5 },
      { x: 50, y: 0 },
      { x: 60, y: 70 },
      { x: 0, y: 80 },
    ];
    expect(quadBounds(out, { width: 40, height: 40 })).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });
});

describe("defaultQuad", () => {
  it("見つからなかったときは画面の内側 5% の枠", () => {
    expect(defaultQuad({ width: 200, height: 400 })).toEqual([
      { x: 10, y: 20 },
      { x: 190, y: 20 },
      { x: 190, y: 380 },
      { x: 10, y: 380 },
    ]);
  });
});
