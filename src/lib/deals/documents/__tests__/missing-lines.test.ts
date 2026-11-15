import { describe, expect, it } from "vitest";
import { appendLines, missingLines } from "../missing-lines";

describe("今の初めの値にあって、欄に無い行(2026-11-15)", () => {
  it("欄に無い行だけを、初めの値の順で返す", () => {
    expect(missingLines("収入印紙\n本人確認書類", "収入印紙\n本人確認書類\n委任状\n実印")).toEqual(["委任状", "実印"]);
    expect(missingLines("実印\n前回だけの行", "収入印紙\n委任状\n実印")).toEqual(["収入印紙", "委任状"]);
  });
  it("全部あれば空(出したことの無い宛先は欄が初めの値そのもの)", () => {
    const fresh = "収入印紙\n印鑑(認印または実印)\n本人確認書類";
    expect(missingLines(fresh, fresh)).toEqual([]);
    expect(missingLines(`${fresh}\n足した行`, fresh)).toEqual([]);
  });
  it("前後の空白と空行は無視し、行の中身はそのまま比べる", () => {
    expect(missingLines("  委任状 \r\n\n　\n実印", "委任状\n\n 実印 \n")).toEqual([]);
    // 似ていても違う行は別のもの
    expect(missingLines("印鑑(認印または実印)", "実印")).toEqual(["実印"]);
  });
  it("初めの値の中の重なりは1つにまとめる", () => {
    expect(missingLines("", "実印\n実印\n委任状")).toEqual(["実印", "委任状"]);
  });
  it("空・無い値でも落ちない", () => {
    expect(missingLines(null, "委任状")).toEqual(["委任状"]);
    expect(missingLines(undefined, "委任状")).toEqual(["委任状"]);
    expect(missingLines("委任状", null)).toEqual([]);
    expect(missingLines("", "")).toEqual([]);
  });
});

describe("欄の末尾に行を足す(2026-11-15)", () => {
  it("1行に1つずつ末尾に足す(今の入力は書き換えない)", () => {
    expect(appendLines("収入印紙\n本人確認書類", ["委任状", "実印"])).toBe("収入印紙\n本人確認書類\n委任状\n実印");
    expect(appendLines("収入印紙\n\n", ["委任状"])).toBe("収入印紙\n委任状");
    expect(appendLines("  字下げの行", ["委任状"])).toBe("  字下げの行\n委任状");
  });
  it("空の欄なら足す行だけ", () => {
    expect(appendLines("", ["委任状", "実印"])).toBe("委任状\n実印");
    expect(appendLines(null, ["委任状"])).toBe("委任状");
  });
  it("すでにある行・重なった行は足さない", () => {
    expect(appendLines("委任状", ["委任状", "実印", "実印"])).toBe("委任状\n実印");
    expect(appendLines("委任状", [])).toBe("委任状");
  });
  it("足したあとは足りない行が無くなる", () => {
    const fresh = "収入印紙\n委任状\n実印";
    expect(missingLines(appendLines("前回の持ち物", missingLines("前回の持ち物", fresh)), fresh)).toEqual([]);
  });
});
