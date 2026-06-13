import { describe, it, expect } from "vitest";
import { removeCorporateNumbersFromText } from "../corporate-number";

const N = "1234567890123";

describe("removeCorporateNumbersFromText", () => {
  it("裸13桁を除去し前後の余白を整える", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ ${N}`, [N])).toBe("株式会社○○");
  });
  it("ラベル付き(ラベル+区切り+番号)をまとめて除去", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ 法人番号:${N} 備考`, [N])).toBe(
      "株式会社○○ 備考",
    );
  });
  it("全角数字の混入も除去(normalize一致)", () => {
    expect(removeCorporateNumbersFromText("株式会社○○ １２３４５６７８９０１２３", [N])).toBe(
      "株式会社○○",
    );
  });
  it("ラベル付きハイフン区切りも除去", () => {
    expect(removeCorporateNumbersFromText(`法人番号: 1234-56-7890123`, [N])).toBe("");
  });
  it("対象外の番号は残す(部分削除)", () => {
    expect(removeCorporateNumbersFromText(`${N} 9999999999999`, [N])).toBe("9999999999999");
  });
  it("先頭/末尾の孤立区切りを除去", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○、${N}`, [N])).toBe("株式会社○○");
  });
  it("numbers が空なら入力をそのまま返す", () => {
    expect(removeCorporateNumbersFromText(`株式会社○○ ${N}`, [])).toBe(`株式会社○○ ${N}`);
  });
  it("null 入力は null", () => {
    expect(removeCorporateNumbersFromText(null, [N])).toBeNull();
    expect(removeCorporateNumbersFromText(undefined, [N])).toBeNull();
  });
  it("番号のみの文字列は空文字になる", () => {
    expect(removeCorporateNumbersFromText(N, [N])).toBe("");
  });
});
