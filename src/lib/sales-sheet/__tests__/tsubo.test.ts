import { describe, it, expect } from "vitest";
import { SQM_PER_TSUBO, parseNumeric, computeTsuboUnitPrice } from "../tsubo";

describe("tsubo", () => {
  it("1坪=400/121㎡", () => { expect(SQM_PER_TSUBO).toBeCloseTo(3.305785, 5); });
  it("parseNumeric はカンマ/㎡等を除去", () => {
    expect(parseNumeric("3,480")).toBe(3480);
    expect(parseNumeric("150.5㎡")).toBe(150.5);
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("　")).toBeNull();
    expect(parseNumeric(undefined)).toBeNull();
  });
  it("坪単価=価格÷(面積÷坪換算)・小数第1位", () => {
    // 3000万 / (150㎡ / 3.305785=45.375坪) = 66.11.. → "66.1"
    expect(computeTsuboUnitPrice("3000", "150")).toBe("66.1");
    expect(computeTsuboUnitPrice("3,480", "150.5㎡")).toBe(computeTsuboUnitPrice("3480", "150.5"));
  });
  it("面積0/空/無効は空文字", () => {
    expect(computeTsuboUnitPrice("3000", "0")).toBe("");
    expect(computeTsuboUnitPrice("3000", "")).toBe("");
    expect(computeTsuboUnitPrice("", "150")).toBe("");
  });
});
