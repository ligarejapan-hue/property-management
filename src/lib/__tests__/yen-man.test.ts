import { describe, expect, it } from "vitest";
import { formatYenJa, formatYenText, manToYen, parseYenText, yenToMan } from "../yen-man";

describe("parseYenText", () => {
  it("数字・カンマ・円・全角を読む", () => {
    expect(parseYenText("32801500")).toBe(32801500);
    expect(parseYenText("32,801,500円")).toBe(32801500);
    expect(parseYenText("３２８０１５００")).toBe(32801500);
    expect(parseYenText(" 1500 ")).toBe(1500);
  });
  it("万の書き方も読む", () => {
    expect(parseYenText("3,280万1,500円")).toBe(32801500);
    expect(parseYenText("3280万円")).toBe(32800000);
    expect(parseYenText("3280万")).toBe(32800000);
  });
  it("円の端数や数字でないものは読まない", () => {
    expect(parseYenText("1500.5")).toBeNull();
    expect(parseYenText("応談")).toBeNull();
    expect(parseYenText("")).toBeNull();
    expect(parseYenText("1,50")).toBeNull();
    expect(parseYenText("-100")).toBeNull();
  });
});

describe("formatYenJa", () => {
  it("ちょうど万なら万円、端数があれば円まで", () => {
    expect(formatYenJa(32800000)).toBe("3,280万円");
    expect(formatYenJa(32801500)).toBe("3,280万1,500円");
    expect(formatYenJa(1500)).toBe("1,500円");
    expect(formatYenJa(0)).toBe("0円");
    expect(formatYenJa(120000000)).toBe("12,000万円");
  });
});

describe("formatYenText", () => {
  it("読めれば整え、読めなければそのまま", () => {
    expect(formatYenText("32801500")).toBe("3,280万1,500円");
    expect(formatYenText("価格応談")).toBe("価格応談");
    expect(formatYenText("")).toBe("");
  });
});

describe("manToYen / yenToMan(万円の保存値 ⇄ 円)", () => {
  it("万円の小数を円の整数へ(浮動小数で誤差を出さない)", () => {
    expect(manToYen("3280")).toBe("32800000");
    expect(manToYen("3280.15")).toBe("32801500");
    expect(manToYen("3280.1500")).toBe("32801500");
    expect(manToYen(0.1)).toBe("1000");
    expect(manToYen("0.0001")).toBe("1");
    expect(manToYen(null)).toBe("");
    expect(manToYen("")).toBe("");
  });
  it("円を万円の文字へ(末尾の0は落とす)", () => {
    expect(yenToMan("32800000")).toBe("3280");
    expect(yenToMan("32801500")).toBe("3280.15");
    expect(yenToMan("1")).toBe("0.0001");
    expect(yenToMan("3,280万1,500円")).toBe("3280.15");
    expect(yenToMan("応談")).toBeNull();
  });
  it("往復しても値が変わらない", () => {
    for (const v of ["0", "1", "999", "12345", "32801500", "99999999999"]) {
      expect(manToYen(yenToMan(v))).toBe(v);
    }
  });
});
