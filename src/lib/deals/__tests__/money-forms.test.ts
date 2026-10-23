import { describe, it, expect } from "vitest";
import { bpToPercentText, parseYen, percentTextToBp, yenText } from "../money-forms";

describe("金額・率の入力", () => {
  it("カンマ・円・空白を無視して整数に・読めなければ null", () => {
    expect(parseYen("30,000,000円")).toBe(30_000_000);
    expect(parseYen(" 120000 ")).toBe(120_000);
    expect(parseYen("")).toBeNull();
    expect(parseYen("12.5")).toBeNull();
    expect(parseYen("-1")).toBeNull();
    expect(yenText(1_056_000)).toBe("1,056,000");
    expect(yenText(null)).toBe("");
  });
  it("率は % の文字と 1/100 % の整数を行き来する", () => {
    expect(bpToPercentText(1000)).toBe("10");
    expect(bpToPercentText(850)).toBe("8.5");
    expect(percentTextToBp("10")).toBe(1000);
    expect(percentTextToBp("8.5")).toBe(850);
    expect(percentTextToBp("8.555")).toBeNull();
    expect(percentTextToBp("x")).toBeNull();
  });
});
