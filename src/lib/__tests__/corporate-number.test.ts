import { describe, it, expect } from "vitest";
import {
  normalizeCorporateNumber,
  extractCorporateNumbersFromText,
  detectCorporateNumberInOwnerLike,
} from "../corporate-number";

describe("normalizeCorporateNumber", () => {
  it("13桁数字を有効と判定する", () => {
    expect(normalizeCorporateNumber("1234567890123")).toBe("1234567890123");
  });

  it("全角数字を半角に正規化する", () => {
    expect(normalizeCorporateNumber("１２３４５６７８９０１２３")).toBe("1234567890123");
  });

  it("ハイフン区切りを除去して正規化する", () => {
    expect(normalizeCorporateNumber("1234-5678-9012-3")).toBe("1234567890123");
    expect(normalizeCorporateNumber("1234ー5678ー9012ー3")).toBe("1234567890123");
    expect(normalizeCorporateNumber("1234‐5678‐9012‐3")).toBe("1234567890123");
  });

  it("空白を除去して正規化する", () => {
    expect(normalizeCorporateNumber(" 1234 5678 9012 3 ")).toBe("1234567890123");
    expect(normalizeCorporateNumber("1234\t5678\n9012 3")).toBe("1234567890123");
  });

  it("全角・ハイフン・空白の混在を正規化する", () => {
    expect(normalizeCorporateNumber("１２３４-５６７８ ９０１２３")).toBe("1234567890123");
  });

  it("12桁は無効", () => {
    expect(normalizeCorporateNumber("123456789012")).toBeNull();
  });

  it("14桁は無効", () => {
    expect(normalizeCorporateNumber("12345678901234")).toBeNull();
  });

  it("空文字 / null / undefined / 空白のみは null", () => {
    expect(normalizeCorporateNumber(null)).toBeNull();
    expect(normalizeCorporateNumber(undefined)).toBeNull();
    expect(normalizeCorporateNumber("")).toBeNull();
    expect(normalizeCorporateNumber("   ")).toBeNull();
  });

  it("数字以外の文字（漢字・英字）が含まれる場合は null", () => {
    expect(normalizeCorporateNumber("1234567890123A")).toBeNull();
    expect(normalizeCorporateNumber("法人 1234567890123")).toBeNull();
  });
});

describe("extractCorporateNumbersFromText", () => {
  it("ラベル付き「法人番号: 1234567890123」を抽出する", () => {
    expect(extractCorporateNumbersFromText("法人番号: 1234567890123")).toEqual([
      "1234567890123",
    ]);
  });

  it("ラベル付き「法人番号 1234567890123」（コロンなし）を抽出する", () => {
    expect(extractCorporateNumbersFromText("法人番号 1234567890123")).toEqual([
      "1234567890123",
    ]);
  });

  it("全角コロン・全角数字でも抽出できる", () => {
    expect(extractCorporateNumbersFromText("法人番号：１２３４５６７８９０１２３")).toEqual([
      "1234567890123",
    ]);
  });

  it("ハイフン区切り混じりのラベル付きも抽出できる", () => {
    expect(
      extractCorporateNumbersFromText("会社法人等番号: 1234-5678-9012-3"),
    ).toEqual(["1234567890123"]);
  });

  it("ラベルなしの裸 13桁数字を抽出する", () => {
    expect(extractCorporateNumbersFromText("株式会社○○ 1234567890123")).toEqual([
      "1234567890123",
    ]);
  });

  it("ラベルなしの裸 全角13桁数字も抽出する(Codex round5: full-width 検出)", () => {
    expect(extractCorporateNumbersFromText("株式会社○○ １２３４５６７８９０１２３")).toEqual([
      "1234567890123",
    ]);
  });

  it("全角ハイフン連結IDの先頭全角13桁は裸番号として誤検出しない(１２３…－４５)", () => {
    expect(extractCorporateNumbersFromText("整理番号 １２３４５６７８９０１２３－４５")).toEqual([]);
  });

  // ── Codex 追加 P1: 会社法人等番号(12桁・ラベル付き)の直後に空白を挟んで
  // 数字で始まる住所断片が続くと、ラベル付き 13桁検出器が空白を跨いで
  // 「12桁ラベル値 + 住所先頭の数字」= 13桁を合成して誤検出していた。
  // ラベル後の値捕捉から空白を除外し、空白跨ぎの数字連結を 13桁候補にしない。
  it("12桁会社法人等番号+空白+住所先頭数字を13桁として誤検出しない(0200-01-012345 1丁目)", () => {
    expect(
      extractCorporateNumbersFromText("会社法人等番号 0200-01-012345 1丁目"),
    ).toEqual([]);
  });

  it("12桁ラベル値+空白+数字(全角)も13桁として誤検出しない", () => {
    expect(
      extractCorporateNumbersFromText("会社法人等番号 ０２００−０１−０１２３４５ １丁目"),
    ).toEqual([]);
  });

  it("正当な13桁ラベル値の直後に数字で始まる住所が続いても13桁は正しく検出する", () => {
    // 値自体が 13桁で完結 → 後続の住所数字は跨がない。
    expect(
      extractCorporateNumbersFromText("法人番号 1234567890123 1丁目2番3号"),
    ).toEqual(["1234567890123"]);
  });

  it("電話番号風 (090-1234-5678 / 03-1234-5678) は誤検出しない", () => {
    expect(extractCorporateNumbersFromText("090-1234-5678")).toEqual([]);
    expect(extractCorporateNumbersFromText("03-1234-5678")).toEqual([]);
    expect(extractCorporateNumbersFromText("Tel: 090-1234-5678")).toEqual([]);
  });

  it("12桁ラベルなしは抽出しない（マイナンバー誤検出防止）", () => {
    expect(extractCorporateNumbersFromText("123456789012")).toEqual([]);
  });

  it("14桁以上の連続数字は抽出しない", () => {
    expect(extractCorporateNumbersFromText("12345678901234")).toEqual([]);
  });

  it("複数の法人番号候補を dedup する", () => {
    const text = "法人番号: 1234567890123 / 法人番号: 1234567890123 / 別の法人番号 9876543210987";
    const result = extractCorporateNumbersFromText(text);
    expect(result.sort()).toEqual(["1234567890123", "9876543210987"].sort());
  });

  it("null / undefined / 空文字で安全に動く", () => {
    expect(extractCorporateNumbersFromText(null)).toEqual([]);
    expect(extractCorporateNumbersFromText(undefined)).toEqual([]);
    expect(extractCorporateNumbersFromText("")).toEqual([]);
    expect(extractCorporateNumbersFromText("   ")).toEqual([]);
  });

  it("ラベルなし13桁が文中にあっても抽出できる（前後に数字・ハイフンが連結していない）", () => {
    expect(extractCorporateNumbersFromText("番号 1234567890123 です")).toEqual([
      "1234567890123",
    ]);
  });

  it("13桁が長い数字列の途中にある場合は抽出しない", () => {
    expect(extractCorporateNumbersFromText("99991234567890123")).toEqual([]);
  });
});

describe("detectCorporateNumberInOwnerLike", () => {
  it("name に法人番号が混入 → detectedIn=['name']", () => {
    const result = detectCorporateNumberInOwnerLike({
      name: "株式会社○○ 1234567890123",
      address: "東京都千代田区1-1",
      note: null,
    });
    expect(result.detectedIn).toEqual(["name"]);
    expect(result.candidates).toEqual(["1234567890123"]);
  });

  it("address に法人番号が混入 → detectedIn=['address']", () => {
    const result = detectCorporateNumberInOwnerLike({
      name: "株式会社○○",
      address: "法人番号: 1234567890123 東京都千代田区1-1",
      note: null,
    });
    expect(result.detectedIn).toEqual(["address"]);
    expect(result.candidates).toEqual(["1234567890123"]);
  });

  it("note のみに混入 → detectedIn=['note']", () => {
    const result = detectCorporateNumberInOwnerLike({
      name: "山田太郎",
      address: "東京都千代田区1-1",
      note: "メモ 法人番号 1234567890123",
    });
    expect(result.detectedIn).toEqual(["note"]);
  });

  it("name と address の両方に混入 → detectedIn 両方", () => {
    const result = detectCorporateNumberInOwnerLike({
      name: "株式会社○○ 1234567890123",
      address: "法人番号 1234567890123 東京都",
    });
    expect(result.detectedIn).toContain("name");
    expect(result.detectedIn).toContain("address");
    // dedup
    expect(result.candidates).toEqual(["1234567890123"]);
  });

  it("検出なし → 空配列", () => {
    const result = detectCorporateNumberInOwnerLike({
      name: "山田太郎",
      address: "東京都千代田区1-1",
      note: null,
    });
    expect(result.detectedIn).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("name=null / address=null / note=null でも安全に動く", () => {
    const result = detectCorporateNumberInOwnerLike({
      name: null,
      address: null,
      note: null,
    });
    expect(result.detectedIn).toEqual([]);
    expect(result.candidates).toEqual([]);
  });
});
