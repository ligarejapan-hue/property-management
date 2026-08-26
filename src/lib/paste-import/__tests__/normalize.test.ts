import { describe, it, expect } from "vitest";
import {
  toHalfWidth,
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
  addressSearchPrefix,
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

describe("addressSearchPrefix（DB前方一致の種・@codex PR#414 P2）", () => {
  it("★数字や英字が現れる手前までのCJKを返す（そこから先は全角/半角がゆれる）", () => {
    expect(addressSearchPrefix("東京都世田谷区等々力2丁目15番12号")).toBe("東京都世田谷区等々力");
    expect(addressSearchPrefix("世田谷区池尻4丁目26-8")).toBe("世田谷区池尻");
  });

  it("★全角で書かれていても、返る種は同じ（幅の別が無いところで切っている）", () => {
    // 本番の住所はほぼ全件が全角。ここが一致しないと候補が1件も返らない。
    expect(addressSearchPrefix("東京都Ａ区Ｂ１－２－３")).toBe(
      addressSearchPrefix("東京都A区B1-2-3"),
    );
  });

  it("前後の空白は無視する", () => {
    expect(addressSearchPrefix("　東京都渋谷区")).toBe("東京都渋谷区");
  });

  it("CJKで始まらなければ null（呼び出し側が従来の contains へ落とす）", () => {
    expect(addressSearchPrefix("1-2-3")).toBeNull();
    expect(addressSearchPrefix("")).toBeNull();
  });
});

describe("parseAreaSqm: 平米だと分かるものだけ採る（4巡目 ③）", () => {
  it("★「20坪（66.1㎡）」は null（20を拾って m² と表示しない）", () => {
    // 最初の数値を拾うと、66.1㎡ の物件が **20㎡** として登録される。
    // 値を捨てるのではなく意味を静かに書き換える＝空欄より悪い。
    expect(parseAreaSqm("20坪（66.1㎡）")).toBeNull();
  });

  it("★坪・帖・畳は換算せず null（換算は新たな推測になる）", () => {
    expect(parseAreaSqm("20坪")).toBeNull();
    expect(parseAreaSqm("6帖")).toBeNull();
    expect(parseAreaSqm("6畳")).toBeNull();
  });

  it("★数値が複数あるものは null（どれが面積か決められない）", () => {
    expect(parseAreaSqm("66.1㎡ / 20坪")).toBeNull();
    expect(parseAreaSqm("1階 70㎡")).toBeNull();
  });

  it("★平米だと明示された単位付き・素の数値は従来どおり採る", () => {
    expect(parseAreaSqm("70㎡")).toBe(70);
    expect(parseAreaSqm("70 平米")).toBe(70);
    expect(parseAreaSqm("70m2")).toBe(70);
    expect(parseAreaSqm("70")).toBe(70);
    expect(parseAreaSqm("1,234.5 ㎡")).toBe(1234.5);
    expect(parseAreaSqm("70平方メートル")).toBe(70);
  });
});
