import { describe, it, expect } from "vitest";
import {
  toHalfWidth,
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
} from "../normalize";

describe("toHalfWidth（全角英数字を半角へ）", () => {
  it("英数字とハイフンを半角にする", () => {
    expect(toHalfWidth("１年以内")).toBe("1年以内");
    expect(toHalfWidth("ＳＡ２６０８－８４２")).toBe("SA2608-842");
  });
  it("日本語はそのまま（カタカナを半角にしない）", () => {
    expect(toHalfWidth("東京都世田谷区")).toBe("東京都世田谷区");
    expect(toHalfWidth("サトウ　ハナコ")).toBe("サトウ　ハナコ");
  });
});

describe("warekiToSeireki（和暦を西暦へ）", () => {
  it("実サンプルの平成8年を1996年にする", () => {
    expect(warekiToSeireki("平成8年建築")).toBe(1996);
  });
  it("元号の境界年を正しく変換する", () => {
    expect(warekiToSeireki("昭和64年")).toBe(1989);
    expect(warekiToSeireki("平成元年")).toBe(1989);
    expect(warekiToSeireki("平成31年")).toBe(2019);
    expect(warekiToSeireki("令和元年")).toBe(2019);
    expect(warekiToSeireki("令和3年")).toBe(2021);
  });
  it("全角数字の和暦も変換する", () => {
    expect(warekiToSeireki("平成８年")).toBe(1996);
  });
  it("西暦がそのまま書かれていれば数値で返す", () => {
    expect(warekiToSeireki("2013 年")).toBe(2013);
    expect(warekiToSeireki("2013年建築")).toBe(2013);
  });
  it("読み取れなければ null（推測しない）", () => {
    expect(warekiToSeireki("築浅")).toBeNull();
    expect(warekiToSeireki("")).toBeNull();
    expect(warekiToSeireki("-")).toBeNull();
  });
  it("元号が分からないものは null", () => {
    expect(warekiToSeireki("大化3年")).toBeNull();
  });
});

describe("parseAreaSqm（面積を数値へ）", () => {
  it("実サンプルの「70 平米」を70にする", () => {
    expect(parseAreaSqm("70 平米")).toBe(70);
  });
  it("㎡・m2・小数・カンマを扱う", () => {
    expect(parseAreaSqm("70.55㎡")).toBe(70.55);
    expect(parseAreaSqm("70m2")).toBe(70);
    expect(parseAreaSqm("1,234.5 ㎡")).toBe(1234.5);
    expect(parseAreaSqm("７０平米")).toBe(70);
  });
  it("数値が無ければ null", () => {
    expect(parseAreaSqm("-")).toBeNull();
    expect(parseAreaSqm("約")).toBeNull();
  });
});

describe("splitLotNumberFromAddress（括弧の中の地番を分ける）", () => {
  it("実サンプルの「（地番552-2）」を分離する", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8（地番552-2）");
    expect(r.address).toBe("世田谷区池尻4丁目26-8");
    expect(r.lotNumber).toBe("552-2");
  });
  it("「（地番：552-2）」のコロン付きも分離する", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8（地番：552-2）");
    expect(r.lotNumber).toBe("552-2");
  });
  it("半角括弧も扱う", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8(地番552-2)");
    expect(r.address).toBe("世田谷区池尻4丁目26-8");
    expect(r.lotNumber).toBe("552-2");
  });
  it("地番が無ければ住所はそのまま・地番は null", () => {
    const r = splitLotNumberFromAddress("東京都世田谷区等々力2丁目15番12号");
    expect(r.address).toBe("東京都世田谷区等々力2丁目15番12号");
    expect(r.lotNumber).toBeNull();
  });
  it("地番以外の括弧書きは住所に残す（勝手に消さない）", () => {
    const r = splitLotNumberFromAddress("世田谷区池尻4丁目26-8（旧町名あり）");
    expect(r.address).toBe("世田谷区池尻4丁目26-8（旧町名あり）");
    expect(r.lotNumber).toBeNull();
  });
});
