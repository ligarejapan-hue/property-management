import { describe, it, expect } from "vitest";
import { buildStrikeLines, isFullyStruck, hasAnyStrike } from "../lines";

/**
 * 下線（抹消）の検出。座標は実物（登記情報提供サービスの全部事項PDF）で測った値に合わせる:
 *   文字の大きさ 8.4pt、1文字ずつの水平線、線の高さ = ベースライン − 1.0pt、行間 8.4pt。
 */
const FS = 8.4;
const item = (str: string, x: number, y: number) => ({
  str,
  x,
  y,
  width: FS * Array.from(str).length,
  fontSize: FS,
});
const underline = (x: number, chars: number, baseline: number) =>
  Array.from({ length: chars }, (_, i) => ({ x1: x + FS * i, x2: x + FS * (i + 1), y: baseline - 1 }));

describe("buildStrikeLines", () => {
  it("文字のすぐ下の線を下線として拾い、文字ごとに印を付ける", () => {
    const lines = buildStrikeLines(
      1,
      [item("┃", 70, 500), item("抵当権設定", 78.4, 500), item("┃", 120.4, 500)],
      underline(78.4, 3, 500), // 「抵当権」だけに下線
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("┃抵当権設定┃");
    expect(lines[0].struck).toEqual([false, true, true, true, false, false, false]);
  });

  it("1つ下の行の高さにある線（＝次の行の下線）は、この行の下線にしない", () => {
    const lines = buildStrikeLines(
      1,
      [item("所有者", 100, 500), item("山田太郎", 100, 491.6)],
      underline(100, 4, 491.6), // 下の行の下線
    );
    expect(lines.map((l) => l.text)).toEqual(["所有者", "山田太郎"]);
    expect(hasAnyStrike(lines[0])).toBe(false);
    expect(isFullyStruck(lines[1])).toBe(true);
  });

  it("線の無いPDF（所有者事項など）では、どの文字にも印を付けない", () => {
    const lines = buildStrikeLines(1, [item("┃所有者┃", 70, 500)], []);
    expect(hasAnyStrike(lines[0])).toBe(false);
  });

  it("行は上から順に並べ、同じ行の文字は左から並べる", () => {
    const lines = buildStrikeLines(
      2,
      [item("下", 70, 400), item("右", 90, 500), item("左", 70, 500)],
      [],
    );
    expect(lines.map((l) => [l.page, l.text])).toEqual([
      [2, "左右"],
      [2, "下"],
    ]);
  });

  it("空白には印を付けない（全部下線かの判定で空白を数えない）", () => {
    const lines = buildStrikeLines(1, [item("甲 野", 70, 500)], underline(70, 3, 500));
    expect(lines[0].struck).toEqual([true, false, true]);
    expect(isFullyStruck(lines[0])).toBe(true);
  });
});
