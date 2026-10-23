import { describe, it, expect } from "vitest";
import { buildStrikeLines, isFullyStruck, hasAnyStrike, segmentsFromPath } from "../lines";

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

describe("segmentsFromPath", () => {
  const id = (x: number, y: number): [number, number] => [x, y];

  it("1つのパスに離れた下線が2本あれば、2本の線分にする（間を埋めない）", () => {
    // A の下 (70〜78.4) と C の下 (86.8〜95.2) だけ。B (78.4〜86.8) には無い
    const segs = segmentsFromPath([0, 70, 499, 1, 78.4, 499, 0, 86.8, 499, 1, 95.2, 499], id);
    expect(segs).toEqual([
      { x1: 70, x2: 78.4, y: 499 },
      { x1: 86.8, x2: 95.2, y: 499 },
    ]);
    const lines = buildStrikeLines(1, [item("ABC", 70, 500)], segs);
    expect(lines[0].struck).toEqual([true, false, true]);
  });

  it("行をまたぐパスでも、各行の下線を取り出す", () => {
    const segs = segmentsFromPath([0, 70, 499, 1, 78.4, 499, 0, 70, 490.6, 1, 78.4, 490.6], id);
    const lines = buildStrikeLines(1, [item("上", 70, 500), item("下", 70, 491.6)], segs);
    expect(lines.map((l) => l.struck[0])).toEqual([true, true]);
  });

  it("細い塗りの四角は1本の下線、高い四角（枠）は捨てる", () => {
    const thin = [0, 70, 498.8, 1, 78.4, 498.8, 1, 78.4, 499.2, 1, 70, 499.2, 3];
    const box = [0, 60, 480, 1, 200, 480, 1, 200, 510, 1, 60, 510, 3];
    expect(segmentsFromPath([...thin, ...box], id)).toEqual([{ x1: 70, x2: 78.4, y: 499 }]);
  });

  it("変換行列を当てた座標で返す", () => {
    const segs = segmentsFromPath([0, 0, 0, 1, 10, 0], (x, y) => [x + 70, y + 499]);
    expect(segs).toEqual([{ x1: 70, x2: 80, y: 499 }]);
  });
});
