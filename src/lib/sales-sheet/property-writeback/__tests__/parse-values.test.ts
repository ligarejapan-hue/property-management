import { describe, it, expect } from "vitest";
import { parseNumeric, parseBuiltYearMonth, pickOption } from "../parse-values";

describe("parseNumeric", () => {
  it("素の数字", () => {
    expect(parseNumeric("3480")).toBe(3480);
    expect(parseNumeric("125.30")).toBe(125.3);
  });
  it("全角・カンマ・前後の空白", () => {
    expect(parseNumeric("１２００")).toBe(1200);
    expect(parseNumeric(" 1,200 ")).toBe(1200);
    expect(parseNumeric("１，２００")).toBe(1200);
  });
  it("末尾の単位は落とす", () => {
    expect(parseNumeric("3,480万円")).toBe(3480);
    expect(parseNumeric("125.30㎡")).toBe(125.3);
    expect(parseNumeric("8.5%")).toBe(8.5);
    expect(parseNumeric("8.5％")).toBe(8.5);
    expect(parseNumeric("5階")).toBe(5);
    expect(parseNumeric("24戸")).toBe(24);
  });
  it("数量でない値は読み取れない", () => {
    expect(parseNumeric("応談")).toBeNull();
    expect(parseNumeric("なし")).toBeNull();
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric(undefined)).toBeNull();
    expect(parseNumeric("1,0,0")).toBeNull();
    expect(parseNumeric("-5")).toBeNull();
  });
});

describe("parseBuiltYearMonth", () => {
  it("西暦", () => {
    expect(parseBuiltYearMonth("2008年3月")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008/3")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008-03")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008年3月1日")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("2008年")).toEqual({ year: 2008, month: null });
  });
  it("和暦", () => {
    expect(parseBuiltYearMonth("平成20年3月")).toEqual({ year: 2008, month: 3 });
    expect(parseBuiltYearMonth("昭和58年")).toEqual({ year: 1983, month: null });
    expect(parseBuiltYearMonth("令和2年5月")).toEqual({ year: 2020, month: 5 });
  });
  it("全角も読める", () => {
    expect(parseBuiltYearMonth("２００８年３月")).toEqual({ year: 2008, month: 3 });
  });
  it("月が範囲外なら月なし", () => {
    expect(parseBuiltYearMonth("2008年13月")).toEqual({ year: 2008, month: null });
    expect(parseBuiltYearMonth("2008年0月")).toEqual({ year: 2008, month: null });
  });
  it("読み取れない書き方", () => {
    expect(parseBuiltYearMonth("築15年")).toBeNull();
    expect(parseBuiltYearMonth("新築")).toBeNull();
    expect(parseBuiltYearMonth("")).toBeNull();
    expect(parseBuiltYearMonth(undefined)).toBeNull();
  });
});

describe("pickOption", () => {
  const OPTS = ["公簿", "実測"] as const;
  it("選択肢にある値だけ通す", () => {
    expect(pickOption("実測", OPTS)).toBe("実測");
    expect(pickOption(" 公簿 ", OPTS)).toBe("公簿");
  });
  it("選択肢に無い値・空は null", () => {
    expect(pickOption("だいたい", OPTS)).toBeNull();
    expect(pickOption("", OPTS)).toBeNull();
    expect(pickOption(undefined, OPTS)).toBeNull();
  });
});
