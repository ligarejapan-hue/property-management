import { describe, it, expect } from "vitest";
import { formatPhoneJp, phoneSearchVariants, isValidPhoneJp } from "../phone-format-jp";

// 発注者決定(2026-09-26): 電話番号はハイフンありで統一。ハイフンなしで入れたら自動で入れる。
// 携帯と固定で区切る位置が違う(固定は市外局番が2〜5桁)ので、市外局番表を持つ既製部品で判定する。
describe("formatPhoneJp", () => {
  it.each([
    ["09012345678", "090-1234-5678"], // 携帯
    ["07012345678", "070-1234-5678"],
    ["05012345678", "050-1234-5678"], // IP電話
    ["0312345678", "03-1234-5678"], // 東京(2桁)
    ["0451234567", "045-123-4567"], // 横浜(3桁)
    ["0466123456", "0466-12-3456"], // 藤沢(4桁)
    ["0126712345", "01267-1-2345"], // 5桁の市外局番
    ["0120123456", "0120-123-456"], // フリーダイヤル
    ["08001234567", "0800-123-4567"],
    ["０３１２３４５６７８", "03-1234-5678"], // 全角
    ["03 1234 5678", "03-1234-5678"], // 空白区切り
    ["0120-12-3456", "0120-123-456"], // 区切り位置の誤りも正しい位置へ
  ])("%s → %s", (input, expected) => {
    expect(formatPhoneJp(input)).toEqual({ value: expected, formatted: true });
  });

  it("すでに正しいハイフンなら formatted=false(変えない)", () => {
    expect(formatPhoneJp("090-1234-5678")).toEqual({ value: "090-1234-5678", formatted: false });
  });

  it("空は空のまま", () => {
    expect(formatPhoneJp("")).toEqual({ value: "", formatted: false });
    expect(formatPhoneJp("   ")).toEqual({ value: "", formatted: false });
  });

  it.each([
    ["031234567"], // 9桁(足りない)
    ["0800123456"], // 0800 は 11桁が正しい
    ["12345"],
    ["03-1234-5678 内線12"], // 内線などの文字が付いたものは触らない
    ["+81312345678"], // 国際表記は勝手に変えない
    ["不明"],
  ])("番号として正しくないもの・文字入りは入力どおり(%s)", (input) => {
    expect(formatPhoneJp(input)).toEqual({ value: input.trim(), formatted: false });
  });
});


// ハイフンありで保存した番号を、ハイフンなしで打っても見つける(逆も)。既存データには
// ハイフンなしの番号も残っているので、両方の書き方で探す。
describe("phoneSearchVariants", () => {
  it("ハイフンなしの完全な番号 → そのまま+ハイフンあり", () => {
    expect(phoneSearchVariants("09012345678")).toEqual(["09012345678", "090-1234-5678"]);
  });
  it("ハイフンありの番号 → そのまま+数字だけ", () => {
    expect(phoneSearchVariants("090-1234-5678")).toEqual(["090-1234-5678", "09012345678"]);
  });
  it("番号の一部(数字だけ)はそのまま1つ", () => {
    expect(phoneSearchVariants("5678")).toEqual(["5678"]);
  });
  it("数字でない語(氏名など)はそのまま1つ", () => {
    expect(phoneSearchVariants("山田")).toEqual(["山田"]);
  });
  it("全角でも数字だけの形を足す", () => {
    expect(phoneSearchVariants("０９０−１２３４")).toEqual(["０９０−１２３４", "0901234"]);
  });
});

// 入力欄を離れたときに「番号を確認してください」を出すかの判定(空は出さない)。
describe("isValidPhoneJp", () => {
  it.each(["09012345678", "090-1234-5678", "03-1234-5678", "0466123456", "０３１２３４５６７８"])("正しい番号は true(%s)", (s) => {
    expect(isValidPhoneJp(s)).toBe(true);
  });
  it.each(["031234567", "0800123456", "12345", "03-1234-5678 内線12", "不明"])("正しくない番号は false(%s)", (s) => {
    expect(isValidPhoneJp(s)).toBe(false);
  });
});
