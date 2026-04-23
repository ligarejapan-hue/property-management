import { describe, it, expect } from "vitest";
import {
  isDuplicateMessage,
  extractDuplicateReason,
} from "../import-row-display";

describe("isDuplicateMessage", () => {
  it("null/undefined/空文字は false", () => {
    expect(isDuplicateMessage(null)).toBe(false);
    expect(isDuplicateMessage(undefined)).toBe(false);
    expect(isDuplicateMessage("")).toBe(false);
  });

  it("「重複」で始まる文字列は true", () => {
    expect(
      isDuplicateMessage(
        "重複の可能性[住所一致（正規化比較）]: 既存物件ID=xxx (東京都港区1-1-1)",
      ),
    ).toBe(true);
    expect(isDuplicateMessage("重複: 同じ棟の101号室が既に存在します")).toBe(
      true,
    );
  });

  it("重複以外のエラー文言は false", () => {
    expect(isDuplicateMessage("住所が空です")).toBe(false);
    expect(isDuplicateMessage("棟名が見つかりません")).toBe(false);
  });
});

describe("extractDuplicateReason", () => {
  it("角括弧内の理由を抜き出す", () => {
    expect(
      extractDuplicateReason(
        "重複の可能性[住所一致（正規化比較）]: 既存物件ID=xxx (住所)",
      ),
    ).toBe("住所一致（正規化比較）");
    expect(
      extractDuplicateReason(
        "重複の可能性[棟内部屋番号一致（正規化比較）]: 既存物件ID=xxx (住所)",
      ),
    ).toBe("棟内部屋番号一致（正規化比較）");
    expect(
      extractDuplicateReason("重複の可能性[realEstateNumber一致]: xxx"),
    ).toBe("realEstateNumber一致");
  });

  it("形式外は null", () => {
    expect(extractDuplicateReason("重複のなにか")).toBeNull();
    expect(extractDuplicateReason("住所が空です")).toBeNull();
    expect(extractDuplicateReason(null)).toBeNull();
  });
});
