import { describe, it, expect } from "vitest";
import { isSameFileName } from "../reselect";

describe("選び直したファイル名の照合", () => {
  it("同じ名前は同じ", () => {
    expect(isSameFileName("謄本_山田.pdf", "謄本_山田.pdf")).toBe(true);
  });
  it("大文字小文字・前後の空白・NFKC の違いは同じとみなす", () => {
    expect(isSameFileName("ABC.PDF", " abc.pdf ")).toBe(true);
    expect(isSameFileName("ｱｲｳ.pdf", "アイウ.pdf")).toBe(true);
  });
  it("違う名前は違う", () => {
    expect(isSameFileName("a.pdf", "b.pdf")).toBe(false);
  });
});
