import { describe, expect, it } from "vitest";
import { searchDirectory, type DirectoryEntry } from "../search";
import { toSearchKey } from "../names";

const e = (code: string, name: string, hira: string, roma: string): DirectoryEntry => ({
  code, name, kana: toSearchKey(hira), roma,
});
const BANKS: DirectoryEntry[] = [
  e("0009", "三井住友銀行", "みついすみとも", "mitsuisumitomo"),
  e("0001", "みずほ銀行", "みずほ", "mizuho"),
  e("0005", "三菱UFJ銀行", "みつびしゆ－えふじえい", "mitsubishiyu-efujiei"),
  e("0010", "りそな銀行", "りそな", "risona"),
  e("9900", "ゆうちょ銀行", "ゆうちよ", "yuucho"),
  e("1310", "さわやか信用金庫", "さわやかしんきん", "sawayakashinkin"),
  e("0137", "東京スター銀行", "とうきようすた－", "toukyousuta-"),
];
const codes = (q: string, limit?: number) => searchDirectory(q, BANKS, limit).map((x) => x.code);

describe("searchDirectory(一文字目から候補を出す)", () => {
  it("ひらがな1文字で、読みがその字で始まるものをコードの順に出す", () => {
    expect(codes("み")).toEqual(["0001", "0005", "0009"]);
  });
  it("カタカナ・半角カナでも同じ", () => {
    expect(codes("ミ")).toEqual(["0001", "0005", "0009"]);
    expect(codes("ﾐ")).toEqual(["0001", "0005", "0009"]);
  });
  it("漢字1文字で、名前がその字で始まるもの", () => {
    expect(codes("三")).toEqual(["0005", "0009"]);
  });
  it("小さい字で打っても当たる(ゆうちょ)", () => {
    expect(codes("ゆうちょ")).toEqual(["9900"]);
  });
  it("ローマ字・英字でも当たる", () => {
    expect(codes("m")).toEqual(["0001", "0005", "0009"]);
    expect(codes("ｍｉｚ")).toEqual(["0001"]);
  });
  it("コードの数字でも当たる", () => {
    expect(codes("13")).toEqual(["1310"]);
  });
  it("2文字以上なら、途中に含むものも先頭一致の後ろに出す", () => {
    expect(codes("住友")).toEqual(["0009"]);
    expect(codes("スター")).toEqual(["0137"]);
    expect(codes("しんきん")).toEqual(["1310"]);
  });
  it("1文字では途中一致は出さない(候補が多すぎるため)", () => {
    expect(codes("友")).toEqual([]);
  });
  it("空・空白だけは何も出さない", () => {
    expect(codes("")).toEqual([]);
    expect(codes("　 ")).toEqual([]);
  });
  it("件数の上限で切る", () => {
    expect(codes("み", 2)).toEqual(["0001", "0005"]);
  });
});
