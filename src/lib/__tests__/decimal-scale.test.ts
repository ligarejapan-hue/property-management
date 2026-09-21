import { describe, it, expect } from "vitest";
import { decimalScale, fitsDecimalScale } from "../decimal-scale";

describe("decimalScale — 小数点以下の桁数", () => {
  it("整数は 0 桁", () => {
    expect(decimalScale(0)).toBe(0);
    expect(decimalScale(3480)).toBe(0);
    expect(decimalScale(-12)).toBe(0);
  });

  it("素直な小数", () => {
    expect(decimalScale(1.5)).toBe(1);
    expect(decimalScale(1.25)).toBe(2);
    expect(decimalScale(123.456)).toBe(3);
  });

  it("2進数で誤差が出やすい値でも正しく数える(0.29 を 100 倍する方式が壊れる例)", () => {
    expect(0.29 * 100).not.toBe(29); // 前提: 掛け算での判定は使えない
    expect(decimalScale(0.29)).toBe(2);
    expect(decimalScale(8.55)).toBe(2);
    expect(decimalScale(1.005)).toBe(3);
  });

  it("末尾の 0 は数えない(1.50 は 1.5 と同じ)", () => {
    expect(decimalScale(1.5)).toBe(1);
    expect(decimalScale(2.0)).toBe(0);
  });

  it("指数表記になる極端な小さい値も数える", () => {
    expect(decimalScale(1e-7)).toBe(7);
    expect(decimalScale(1.2e-5)).toBe(6);
  });

  it("有限でない値はどの上限にも収まらない", () => {
    expect(decimalScale(NaN)).toBe(Infinity);
    expect(decimalScale(Infinity)).toBe(Infinity);
    expect(fitsDecimalScale(NaN, 2)).toBe(false);
  });
});

describe("fitsDecimalScale — 列の桁数に収まるか", () => {
  it("DECIMAL(12,1) 相当: 1桁まで", () => {
    expect(fitsDecimalScale(18800, 1)).toBe(true);
    expect(fitsDecimalScale(18800.5, 1)).toBe(true);
    expect(fitsDecimalScale(1.25, 1)).toBe(false); // DBでは 1.3 に丸められてしまう
  });

  it("DECIMAL(10,2) 相当: 2桁まで", () => {
    expect(fitsDecimalScale(120.55, 2)).toBe(true);
    expect(fitsDecimalScale(120.555, 2)).toBe(false);
  });
});
