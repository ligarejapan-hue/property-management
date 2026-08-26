import { describe, it, expect } from "vitest";
import {
  toHalfWidth,
  warekiToSeireki,
  parseAreaSqm,
  splitLotNumberFromAddress,
  addressSearchPrefix,
  stripLeadingPostalCode,
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

describe("warekiToSeireki: 存在しない元号年は採らない（5巡目 ③）", () => {
  it("★終わった元号の実在する最後の年を超えたら null", () => {
    // これまで「平成32年」は 2020 に、「昭和65年」は 1990 に化け、確認画面は
    // 緑(拾えた)で表示してそのまま備考へ書き込んでいた。元資料の誤りを
    // 別のデータに書き換えている＝空欄より悪い。
    expect(warekiToSeireki("平成32年")).toBeNull();
    expect(warekiToSeireki("昭和65年")).toBeNull();
    expect(warekiToSeireki("大正16年")).toBeNull();
    expect(warekiToSeireki("明治46年")).toBeNull();
  });

  it("★境界のちょうど下（実在する最後の年）は通る", () => {
    expect(warekiToSeireki("平成31年")).toBe(2019);
    expect(warekiToSeireki("昭和64年")).toBe(1989);
    expect(warekiToSeireki("大正15年")).toBe(1926);
    expect(warekiToSeireki("明治45年")).toBe(1912);
  });

  it("★令和は継続中なので上限を置かない", () => {
    expect(warekiToSeireki("令和8年")).toBe(2026);
    expect(warekiToSeireki("令和32年")).toBe(2050);
  });
});

describe("stripLeadingPostalCode / addressSearchPrefix: 郵便番号で始まる住所（5巡目 ②）", () => {
  it("★〒つき・〒なし・全角・ハイフンなし のいずれでも先頭の郵便番号を落とす", () => {
    expect(stripLeadingPostalCode("〒123-4567 東京都A区B1-2-3")).toBe("東京都A区B1-2-3");
    expect(stripLeadingPostalCode("123-4567 東京都A区B1-2-3")).toBe("東京都A区B1-2-3");
    expect(stripLeadingPostalCode("〒１２３－４５６７　東京都A区B1-2-3")).toBe("東京都A区B1-2-3");
    expect(stripLeadingPostalCode("〒1234567 東京都A区B1-2-3")).toBe("東京都A区B1-2-3");
  });

  it("★郵便番号が無い住所は何も変えない", () => {
    expect(stripLeadingPostalCode("東京都A区B1-2-3")).toBe("東京都A区B1-2-3");
  });

  it("★郵便番号で始まっても CJK の前方一致が取れる（生の contains へ落ちない）", () => {
    // 落ちていた先は「本番の住所は99.4%が全角なのでほぼ当たらない」経路。
    expect(addressSearchPrefix("〒123-4567 東京都世田谷区等々力2丁目")).toBe("東京都世田谷区等々力");
    expect(addressSearchPrefix("〒123-4567 東京都世田谷区等々力2丁目")).toBe(
      addressSearchPrefix("東京都世田谷区等々力2丁目"),
    );
  });

  it("★住所の途中に出てくる数字は郵便番号とみなさない（先頭だけ）", () => {
    expect(stripLeadingPostalCode("東京都A区123-4567")).toBe("東京都A区123-4567");
  });
});

describe("warekiToSeireki: 上限は引数で受け取る（6巡目 ④）", () => {
  // ⚠テストの中で時計を読まない。上限は固定値で渡す。
  const BOUND = { maxYear: 2026 };

  it("★上限を渡すと、それを超える年は null（令和にも西暦にも効く）", () => {
    // 上限が無いと「令和99年」は 2117 として、「2099年」はそのまま通っていた。
    expect(warekiToSeireki("令和99年", BOUND)).toBeNull();
    expect(warekiToSeireki("2099年", BOUND)).toBeNull();
    expect(warekiToSeireki("2027年", BOUND)).toBeNull();
  });

  it("★上限ちょうどの年は通る（境界の下）", () => {
    expect(warekiToSeireki("2026年", BOUND)).toBe(2026);
    expect(warekiToSeireki("令和8年", BOUND)).toBe(2026);
  });

  it("★上限を渡さなければ従来どおり（省略＝上限なし）", () => {
    expect(warekiToSeireki("令和99年")).toBe(2117);
    expect(warekiToSeireki("2099年")).toBe(2099);
  });

  it("★終わった元号の上限は、年の上限とは別に効き続ける", () => {
    expect(warekiToSeireki("平成32年", BOUND)).toBeNull();
    expect(warekiToSeireki("平成31年", BOUND)).toBe(2019);
  });

  it("★同じ入力に同じ結果を返す（時計に依存していない）", () => {
    // 決定的であること自体を固定する。実装が Date を読み始めると、
    // 上限を渡さない呼び出しの結果が環境で変わりうる。
    expect(warekiToSeireki("2099年")).toBe(warekiToSeireki("2099年"));
    expect(warekiToSeireki("2099年", { maxYear: 3000 })).toBe(2099);
  });
});
