import { describe, it, expect } from "vitest";
import {
  isDuplicateMessage,
  extractDuplicateReason,
  isUpdateMessage,
  extractUpdateReason,
  extractUpdatedFields,
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

describe("isUpdateMessage", () => {
  it("「更新」で始まる文字列は true", () => {
    expect(
      isUpdateMessage(
        "更新[realEstateNumber一致]: 既存物件ID=xxx (更新項目: address, note)",
      ),
    ).toBe(true);
  });

  it("重複・その他は false", () => {
    expect(isUpdateMessage("重複の可能性[住所一致（正規化比較）]: ...")).toBe(
      false,
    );
    expect(isUpdateMessage("住所が空です")).toBe(false);
    expect(isUpdateMessage(null)).toBe(false);
    expect(isUpdateMessage("")).toBe(false);
  });
});

describe("extractUpdateReason", () => {
  it("角括弧内の理由を抜き出す", () => {
    expect(
      extractUpdateReason(
        "更新[棟内部屋番号一致（正規化比較）]: 既存物件ID=xxx (更新項目: address)",
      ),
    ).toBe("棟内部屋番号一致（正規化比較）");
  });

  it("更新メッセージ以外は null", () => {
    expect(
      extractUpdateReason("重複の可能性[住所一致（正規化比較）]: ..."),
    ).toBeNull();
    expect(extractUpdateReason(null)).toBeNull();
  });
});

describe("extractUpdatedFields", () => {
  it("更新項目の一覧を配列で返す", () => {
    expect(
      extractUpdatedFields(
        "更新[realEstateNumber一致]: 既存物件ID=xxx (更新項目: address, note, floorNo)",
      ),
    ).toEqual(["address", "note", "floorNo"]);
  });

  it("更新項目が 1 件のケース", () => {
    expect(
      extractUpdatedFields(
        "更新[externalLinkKey一致]: 既存物件ID=xxx (更新項目: address)",
      ),
    ).toEqual(["address"]);
  });

  it("更新メッセージ以外は空配列", () => {
    expect(extractUpdatedFields("重複の可能性[...]: ...")).toEqual([]);
    expect(extractUpdatedFields(null)).toEqual([]);
  });
});
