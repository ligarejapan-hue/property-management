import { describe, it, expect } from "vitest";
import { LABEL_DICTIONARY, fieldKeyForLabel, type DraftFieldKey } from "../label-dictionary";

describe("fieldKeyForLabel（見出し名からアプリの欄を引く）", () => {
  it("実サンプルAのラベルを引ける", () => {
    expect(fieldKeyForLabel("物件所在地")).toBe("address");
    expect(fieldKeyForLabel("物件種別")).toBe("propertyTypeRaw");
    expect(fieldKeyForLabel("築年数")).toBe("builtYearRaw");
  });

  it("実サンプルBのラベルを引ける", () => {
    expect(fieldKeyForLabel("査定ナンバー")).toBe("externalLinkKey");
    expect(fieldKeyForLabel("物件名称")).toBe("buildingName");
    expect(fieldKeyForLabel("建物（専有）面積")).toBe("exclusiveArea");
    expect(fieldKeyForLabel("間取り")).toBe("layoutType");
    expect(fieldKeyForLabel("築年（西暦）")).toBe("builtYearRaw");
    expect(fieldKeyForLabel("現況")).toBe("occupancyRaw");
    expect(fieldKeyForLabel("お名前")).toBe("ownerName");
    expect(fieldKeyForLabel("フリガナ")).toBe("ownerNameKana");
    expect(fieldKeyForLabel("電話番号")).toBe("ownerPhone");
    expect(fieldKeyForLabel("E-mail")).toBe("ownerEmail");
    expect(fieldKeyForLabel("ご住所")).toBe("ownerAddress");
  });

  it("全角半角・空白のゆれを吸収する", () => {
    expect(fieldKeyForLabel("Ｅ-ｍａｉｌ")).toBe("ownerEmail");
    expect(fieldKeyForLabel("お 名 前")).toBe("ownerName");
    expect(fieldKeyForLabel("e-mail")).toBe("ownerEmail");
  });

  it("⚠「住所」だけの見出しは所有者住所にしない（物件所在地と紛れるため null）", () => {
    expect(fieldKeyForLabel("住所")).toBeNull();
  });

  it("辞書に無い見出しは null（捨てずに備考へ回すのは呼び出し側の仕事）", () => {
    expect(fieldKeyForLabel("心理的瑕疵事項")).toBeNull();
    expect(fieldKeyForLabel("")).toBeNull();
  });

  it("同じ見出しが2つの欄に登録されていない（引き当てが一意）", () => {
    const seen = new Map<string, DraftFieldKey>();
    for (const [key, labels] of Object.entries(LABEL_DICTIONARY)) {
      for (const label of labels) {
        expect(seen.has(label), `「${label}」が ${seen.get(label)} と ${key} に重複`).toBe(false);
        seen.set(label, key as DraftFieldKey);
      }
    }
    expect(seen.size).toBeGreaterThan(20); // 空振り防止
  });
});
