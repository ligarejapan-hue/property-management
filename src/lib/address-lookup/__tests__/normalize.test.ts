import { describe, it, expect } from "vitest";
import {
  normalizePostalCode,
  isValidPostalCode,
  formatPostalCode,
  normalizeAddress,
} from "../normalize";

describe("normalizePostalCode", () => {
  it("半角7桁はそのまま", () => {
    expect(normalizePostalCode("1234567")).toBe("1234567");
  });
  it("ハイフンを除去する", () => {
    expect(normalizePostalCode("123-4567")).toBe("1234567");
  });
  it("全角数字を半角へ変換する", () => {
    expect(normalizePostalCode("１２３４５６７")).toBe("1234567");
  });
  it("前後・途中の空白(半角/全角)を除去する", () => {
    expect(normalizePostalCode("  123 4567 ")).toBe("1234567");
    expect(normalizePostalCode("123　4567")).toBe("1234567"); // 全角スペース
  });
  it("全角ハイフン類を除去する", () => {
    expect(normalizePostalCode("１２３－４５６７")).toBe("1234567");
  });
  it("数学マイナス(U+2212)を含む全角入力も除去する", () => {
    expect(normalizePostalCode("０１０−0４９２")).toBe("0100492");
  });
});

describe("isValidPostalCode", () => {
  it("正規化後7桁の数字なら true", () => {
    expect(isValidPostalCode("1234567")).toBe(true);
    expect(isValidPostalCode("123-4567")).toBe(true);
    expect(isValidPostalCode("１２３４５６７")).toBe(true);
  });
  it("6桁は false", () => {
    expect(isValidPostalCode("123456")).toBe(false);
  });
  it("8桁は false", () => {
    expect(isValidPostalCode("12345678")).toBe(false);
  });
  it("数字以外を含むものは false", () => {
    expect(isValidPostalCode("1234567x")).toBe(false);
    expect(isValidPostalCode("abc4567")).toBe(false);
  });
  it("空文字は false", () => {
    expect(isValidPostalCode("")).toBe(false);
  });
});

describe("formatPostalCode", () => {
  it("正規の7桁を 123-4567 形式へ整形する", () => {
    expect(formatPostalCode("1234567")).toBe("123-4567");
    expect(formatPostalCode("１２３４５６７")).toBe("123-4567");
    expect(formatPostalCode("123-4567")).toBe("123-4567");
  });
  it("7桁でない入力は正規化後の文字列をそのまま返す(非throw)", () => {
    expect(formatPostalCode("123456")).toBe("123456");
  });
});

describe("normalizeAddress", () => {
  it("前後の空白を除去する", () => {
    expect(normalizeAddress("  東京都千代田区  ")).toBe("東京都千代田区");
  });
  it("連続空白を1つに整理する(全角スペース含む)", () => {
    expect(normalizeAddress("東京都   千代田区")).toBe("東京都 千代田区");
    expect(normalizeAddress("東京都　　千代田区")).toBe("東京都 千代田区");
  });
  it("通常の住所は不変", () => {
    expect(normalizeAddress("東京都千代田区丸の内1-1-1")).toBe(
      "東京都千代田区丸の内1-1-1",
    );
  });
});
