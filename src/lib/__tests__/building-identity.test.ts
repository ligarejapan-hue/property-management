import { describe, it, expect } from "vitest";
import {
  buildingNameKey,
  areaKey,
  buildingAddressFromUnit,
  parseKanjiNumber,
} from "@/lib/building-identity";

describe("parseKanjiNumber", () => {
  it.each([
    ["一", 1], ["十", 10], ["十二", 12], ["二十", 20], ["二十一", 21],
    ["百", 100], ["百二", 102], ["一〇", 10],
  ])("%s → %d", (run, n) => expect(parseKanjiNumber(run)).toBe(n));
  it("漢数字以外が混ざれば null", () => expect(parseKanjiNumber("一a")).toBeNull());
});

describe("buildingNameKey", () => {
  // 同じ棟とみなす組(比べる形が一致する)
  it.each([
    ["パークハウス第一", "パークハウス第１"],
    ["パークハウス第一", "パークハウス第1"],
    ["パークハウス第十二", "パークハウス第12"],
    ["ライオンズマンションⅡ", "ライオンズマンション2"],
    ["ライオンズマンションⅡ", "ライオンズマンション２"],
    ["グランドメゾン二番館", "グランドメゾン2番館"],
    ["シティ三号棟", "シティ3号棟"],
    ["霞ヶ関ハイツ", "霞ケ関ハイツ"],
    ["霞ヶ関ハイツ", "霞が関ハイツ"],
    ["杜の街", "杜ノ街"],
    ["メゾン・ド・ルミエール", "メゾン・ド・ルミエール"],
    ["サンライズ－２", "サンライズ-2"],
    ["コーポ ＡＢＣ", "コーポabc"],
    ["ⅶ番街", "7番街"],
  ])("%s と %s は同じ", (a, b) => {
    expect(buildingNameKey(a)).toBe(buildingNameKey(b));
  });

  // 別の棟のまま(変えてはいけない)
  it.each([
    ["一番町ハイツ", "1番町ハイツ"], // 地名の一は変えない
    ["ライオンズマンションII", "ライオンズマンション2"], // 英字の II は変えない
    ["第一ビル", "第二ビル"],
    ["一碧荘", "1碧荘"], // 固有名の一は変えない
  ])("%s と %s は別", (a, b) => {
    expect(buildingNameKey(a)).not.toBe(buildingNameKey(b));
  });

  it("末尾の『マンション』を外さない", () => {
    expect(buildingNameKey("リガーレマンション")).not.toBe(buildingNameKey("リガーレ"));
  });

  it.each([[null], [undefined], [""], ["  　"]])("空(%s)は null", (v) => {
    expect(buildingNameKey(v as string | null | undefined)).toBeNull();
  });
});

describe("areaKey", () => {
  it.each([
    ["東京都大田区南雪谷１丁目１６４－２－４５", "東京都大田区南雪谷1丁目"],
    ["東京都大田区南雪谷一丁目5番3号", "東京都大田区南雪谷1丁目"],
    ["東京都港区六本木六丁目10-1", "東京都港区六本木6丁目"],
    ["東京都北区東十条四丁目1", "東京都北区東十条4丁目"],
    ["東京都 大田区 南雪谷 1丁目 5", "東京都大田区南雪谷1丁目"],
    ["千葉県○○市大字△△１２３", "千葉県○○市大字△△"],
    ["大田区南雪谷1丁目", "大田区南雪谷1丁目"], // 都道府県なしはそのまま
  ])("%s → %s", (addr, key) => expect(areaKey(addr)).toBe(key));

  it.each([
    [null], [""], ["南雪谷1丁目"], // 市区町村を含まない
    ["123-4"],
  ])("取り出せない(%s)は null", (v) => {
    expect(areaKey(v as string | null)).toBeNull();
  });
});

describe("buildingAddressFromUnit", () => {
  it("住所の末尾が家屋番号と一致するときだけ、最後の部分を除く", () => {
    expect(
      buildingAddressFromUnit("東京都大田区南雪谷１丁目１６４－２－４５", "１６４－２－４５"),
    ).toBe("東京都大田区南雪谷１丁目１６４－２");
  });
  it("全角/半角が違っても一致とみなす", () => {
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目164-2-45", "１６４－２－４５")).toBe(
      "東京都大田区南雪谷1丁目164-2",
    );
  });
  it("一致しない(手入力の住居表示)ときは住所のまま", () => {
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目5番3号", "164-2-45")).toBe(
      "東京都大田区南雪谷1丁目5番3号",
    );
  });
  it("家屋番号が無い・区切りが無いときは住所のまま", () => {
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目164", null)).toBe("東京都大田区南雪谷1丁目164");
    expect(buildingAddressFromUnit("東京都大田区南雪谷1丁目164", "164")).toBe("東京都大田区南雪谷1丁目164");
  });
});
