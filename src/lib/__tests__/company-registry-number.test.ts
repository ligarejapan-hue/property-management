import { describe, it, expect } from "vitest";
import {
  normalizeCompanyRegistryNumber,
  extractCompanyRegistryNumbersFromText,
  removeCompanyRegistryNumbersFromText,
} from "../corporate-number";

// 会社法人等番号(12桁・登記の番号)= 国税庁の法人番号(13桁)とは別物。
// 誤検出(電話番号 / マイナンバー等)回避のため「ラベル付きのみ」を基本とする。

describe("normalizeCompanyRegistryNumber", () => {
  it("12桁数字を有効と判定する", () => {
    expect(normalizeCompanyRegistryNumber("020001012345")).toBe("020001012345");
  });

  it("全角数字を半角に正規化する", () => {
    expect(normalizeCompanyRegistryNumber("０２０００１０１２３４５")).toBe("020001012345");
  });

  it("ハイフン区切り(登記表記 XXXX-XX-XXXXXX)を除去して正規化する", () => {
    expect(normalizeCompanyRegistryNumber("0200-01-012345")).toBe("020001012345");
    expect(normalizeCompanyRegistryNumber("0200ー01ー012345")).toBe("020001012345");
    expect(normalizeCompanyRegistryNumber("０２００−０１−０１２３４５")).toBe("020001012345");
  });

  it("空白を除去して正規化する", () => {
    expect(normalizeCompanyRegistryNumber(" 0200 01 012345 ")).toBe("020001012345");
  });

  it("13桁(法人番号)は無効(混同しない)", () => {
    expect(normalizeCompanyRegistryNumber("1234567890123")).toBeNull();
  });

  it("11桁は無効", () => {
    expect(normalizeCompanyRegistryNumber("01234567890")).toBeNull();
  });

  it("空文字 / null / undefined / 空白のみは null", () => {
    expect(normalizeCompanyRegistryNumber(null)).toBeNull();
    expect(normalizeCompanyRegistryNumber(undefined)).toBeNull();
    expect(normalizeCompanyRegistryNumber("")).toBeNull();
    expect(normalizeCompanyRegistryNumber("   ")).toBeNull();
  });

  it("数字以外の文字が含まれる場合は null", () => {
    expect(normalizeCompanyRegistryNumber("020001012345A")).toBeNull();
  });
});

describe("extractCompanyRegistryNumbersFromText", () => {
  it("ラベル付き「会社法人等番号 0200-01-012345」を抽出する", () => {
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 0200-01-012345"),
    ).toEqual(["020001012345"]);
  });

  it("全角ラベル・全角数字・全角ハイフンでも抽出できる", () => {
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 ０２００−０１−０１２３４５"),
    ).toEqual(["020001012345"]);
  });

  it("「法人等番号:」ラベルでも抽出できる", () => {
    expect(
      extractCompanyRegistryNumbersFromText("法人等番号: 020001012345"),
    ).toEqual(["020001012345"]);
  });

  it("ラベルなしの裸 12桁は抽出しない(誤検出回避=電話番号/マイナンバー対策)", () => {
    expect(extractCompanyRegistryNumbersFromText("020001012345")).toEqual([]);
    expect(extractCompanyRegistryNumbersFromText("株式会社○○ 020001012345")).toEqual([]);
  });

  it("ラベル付きでも桁数が12でなければ抽出しない(13桁=法人番号は対象外)", () => {
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 1234567890123"),
    ).toEqual([]);
  });

  it("電話番号風はラベルが無ければ抽出しない", () => {
    expect(extractCompanyRegistryNumbersFromText("Tel 090-1234-5678")).toEqual([]);
  });

  it("複数のラベル付き番号を dedup する", () => {
    const text = "会社法人等番号 0200-01-012345 / 会社法人等番号 020001012345";
    expect(extractCompanyRegistryNumbersFromText(text)).toEqual(["020001012345"]);
  });

  it("null / undefined / 空文字で安全に動く", () => {
    expect(extractCompanyRegistryNumbersFromText(null)).toEqual([]);
    expect(extractCompanyRegistryNumbersFromText(undefined)).toEqual([]);
    expect(extractCompanyRegistryNumbersFromText("")).toEqual([]);
  });

  it("13桁ラベル(法人番号)を会社法人等番号として誤抽出しない", () => {
    // 「法人番号: 1234567890123」は 13桁 → 12桁抽出器は拾わない
    expect(
      extractCompanyRegistryNumbersFromText("法人番号: 1234567890123"),
    ).toEqual([]);
  });

  // ── Codex 追加 P2: ラベル付き値の数字列の「後ろに非数字サフィックス」がある場合、
  // 右境界が無いと先頭12桁だけ部分一致して妥当な会社法人等番号と誤認してしまう。
  // 12桁で完結していないトークンは保守的に「会社法人等番号として扱わない=抽出/除去しない」。
  it("12桁の直後に英字サフィックスが続く場合は部分一致で抽出しない", () => {
    // "020001012345A" は先頭12桁だけ拾うと一見妥当に見えるが、トークンが12桁で
    // 完結していない(直後に英字)ため別番号の可能性 → 抽出しない。
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 020001012345A"),
    ).toEqual([]);
  });

  it("全角12桁の直後に英字が続く場合も部分一致で抽出しない", () => {
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 ０２００−０１−０１２３４５abc"),
    ).toEqual([]);
  });

  it("12桁の直後に更に数字が続く(13桁以上に化ける)場合は12桁部分一致しない", () => {
    // 半角13連続: 全体トークンを拾うと13桁 → normalize で弾かれ抽出されない。
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 0200010123450"),
    ).toEqual([]);
    // 全角13連続も同様。
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 ０２０００１０１２３４５１"),
    ).toEqual([]);
  });

  it("桁不足/別番号の可能性(『012345号』等)を誤って部分抽出しない", () => {
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 012345号"),
    ).toEqual([]);
  });

  it("12桁で完結する実例(全角ハイフン表記)は従来どおり抽出できる", () => {
    expect(
      extractCompanyRegistryNumbersFromText("会社法人等番号 ０２００−０１−０１２３４５"),
    ).toEqual(["020001012345"]);
  });
});

describe("removeCompanyRegistryNumbersFromText", () => {
  const REG = "020001012345";

  it("ラベル「会社法人等番号」ごと 12桁を除去し残骸を残さない", () => {
    expect(
      removeCompanyRegistryNumbersFromText("東京都港区1-1 会社法人等番号 0200-01-012345", [REG]),
    ).toBe("東京都港区1-1");
  });

  it("全角ラベル・全角数字・全角ハイフンも除去", () => {
    expect(
      removeCompanyRegistryNumbersFromText("東京都港区1-1 会社法人等番号 ０２００−０１−０１２３４５", [REG]),
    ).toBe("東京都港区1-1");
  });

  it("末尾の孤立区切りを残さない", () => {
    expect(
      removeCompanyRegistryNumbersFromText("東京都港区1-1、会社法人等番号 020001012345", [REG]),
    ).toBe("東京都港区1-1");
  });

  it("対象外フィールド(番号なし)は原文不変(無関係改変防止)", () => {
    expect(removeCompanyRegistryNumbersFromText("東京都　港区", [REG])).toBe("東京都　港区");
    expect(removeCompanyRegistryNumbersFromText("  株式会社○○  ", [REG])).toBe("  株式会社○○  ");
  });

  it("numbers が空なら入力をそのまま返す", () => {
    expect(removeCompanyRegistryNumbersFromText("会社法人等番号 020001012345", [])).toBe(
      "会社法人等番号 020001012345",
    );
  });

  it("null 入力は null", () => {
    expect(removeCompanyRegistryNumbersFromText(null, [REG])).toBeNull();
    expect(removeCompanyRegistryNumbersFromText(undefined, [REG])).toBeNull();
  });

  it("ラベルなし裸12桁は除去しない(検出対象外=破壊しない)", () => {
    expect(removeCompanyRegistryNumbersFromText("整理番号 020001012345", [REG])).toBe(
      "整理番号 020001012345",
    );
  });

  it("13桁(法人番号)は会社法人等番号としては除去しない", () => {
    expect(
      removeCompanyRegistryNumbersFromText("会社法人等番号 1234567890123", [REG]),
    ).toBe("会社法人等番号 1234567890123");
  });

  it("番号のみ(ラベル+番号)の文字列は空文字になる", () => {
    expect(removeCompanyRegistryNumbersFromText("会社法人等番号 020001012345", [REG])).toBe("");
  });

  // ── Codex 追加 P2: 右境界が無いと "020001012345A" の先頭12桁だけを部分除去し、
  // "会社法人等番号 A" のような壊れた残骸を生む恐れ。12桁で完結していないトークンは
  // 除去対象にしない(原文を保つ)。
  it("12桁の直後に英字サフィックスが続く場合は部分除去しない(原文保持)", () => {
    expect(
      removeCompanyRegistryNumbersFromText("会社法人等番号 020001012345A", [REG]),
    ).toBe("会社法人等番号 020001012345A");
  });

  it("全角12桁の直後に英字が続く場合も部分除去しない(原文保持)", () => {
    expect(
      removeCompanyRegistryNumbersFromText("会社法人等番号 ０２００−０１−０１２３４５abc", [REG]),
    ).toBe("会社法人等番号 ０２００−０１−０１２３４５abc");
  });

  it("12桁で完結する実例(全角ハイフン表記)は従来どおり除去できる", () => {
    expect(
      removeCompanyRegistryNumbersFromText("東京都港区1-1 会社法人等番号 ０２００−０１−０１２３４５", [REG]),
    ).toBe("東京都港区1-1");
  });
});
