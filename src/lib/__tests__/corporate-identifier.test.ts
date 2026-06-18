/**
 * 会社法人等番号(12桁) ⇔ 法人番号(13桁) の変換・検証・分類の純関数テスト。
 *
 * 重要:
 *  - 12桁=会社法人等番号 / 13桁=法人番号 を別物として扱う。
 *  - 12桁から国税庁チェックデジットを算出して13桁にできる。
 *  - 13桁はチェックデジットを検証する。
 *  - 12桁と13桁を混同しない(12桁を13桁として妥当判定しない / 算出結果は別値)。
 */
import { describe, it, expect } from "vitest";
import {
  normalizeCorporateIdentifier,
  calculateCorporateNumberFromCompanyNumber,
  isValidCorporateNumber13,
  classifyCorporateIdentifier,
  normalizeCorporateNumber,
} from "../corporate-number";

describe("normalizeCorporateIdentifier", () => {
  it("全角数字→半角・ハイフン/空白を除去する", () => {
    expect(normalizeCorporateIdentifier("７００１１０００５９０１")).toBe(
      "700110005901",
    );
    expect(normalizeCorporateIdentifier("7001-1000-5901")).toBe("700110005901");
    expect(normalizeCorporateIdentifier(" 700110005901 ")).toBe("700110005901");
    expect(normalizeCorporateIdentifier("0200－01－012345")).toBe("020001012345");
  });
  it("null/空/数字以外を含む → null", () => {
    expect(normalizeCorporateIdentifier(null)).toBeNull();
    expect(normalizeCorporateIdentifier(undefined)).toBeNull();
    expect(normalizeCorporateIdentifier("")).toBeNull();
    expect(normalizeCorporateIdentifier("   ")).toBeNull();
    expect(normalizeCorporateIdentifier("12A45")).toBeNull();
    expect(normalizeCorporateIdentifier("法人番号")).toBeNull();
  });
});

describe("calculateCorporateNumberFromCompanyNumber", () => {
  it("公式例: 700110005901 → 8700110005901", () => {
    expect(calculateCorporateNumberFromCompanyNumber("700110005901")).toBe(
      "8700110005901",
    );
  });
  it("提示サイト例: 326405515335 → 8326405515335", () => {
    expect(calculateCorporateNumberFromCompanyNumber("326405515335")).toBe(
      "8326405515335",
    );
  });
  it("全角・ハイフン・空白入りでも算出できる", () => {
    expect(
      calculateCorporateNumberFromCompanyNumber("７００１１０００５９０１"),
    ).toBe("8700110005901");
    expect(calculateCorporateNumberFromCompanyNumber("7001-1000-5901")).toBe(
      "8700110005901",
    );
    expect(calculateCorporateNumberFromCompanyNumber(" 326405515335 ")).toBe(
      "8326405515335",
    );
  });
  it("チェックデジットが mod9==0 の場合は 9 を付ける(000000000000 → 9000000000000)", () => {
    expect(calculateCorporateNumberFromCompanyNumber("000000000000")).toBe(
      "9000000000000",
    );
  });
  it("12桁でない(11/13桁・空・数字以外) → null", () => {
    expect(calculateCorporateNumberFromCompanyNumber("70011000590")).toBeNull(); // 11桁
    expect(
      calculateCorporateNumberFromCompanyNumber("8700110005901"),
    ).toBeNull(); // 13桁
    expect(calculateCorporateNumberFromCompanyNumber(null)).toBeNull();
    expect(calculateCorporateNumberFromCompanyNumber("12345678901A")).toBeNull();
  });
});

describe("isValidCorporateNumber13", () => {
  it("正しい13桁法人番号 → true", () => {
    expect(isValidCorporateNumber13("8700110005901")).toBe(true);
    expect(isValidCorporateNumber13("8326405515335")).toBe(true);
    expect(isValidCorporateNumber13("9000000000000")).toBe(true);
  });
  it("チェックデジット不正な13桁 → false", () => {
    // 正: 8700110005901。先頭を 1 に変えるとCD不一致。
    expect(isValidCorporateNumber13("1700110005901")).toBe(false);
    expect(isValidCorporateNumber13("0700110005901")).toBe(false);
  });
  it("12桁(会社法人等番号)を13桁として妥当判定しない → false", () => {
    expect(isValidCorporateNumber13("700110005901")).toBe(false); // 12桁
  });
  it("桁数違い・数字以外 → false", () => {
    expect(isValidCorporateNumber13("87001100059012")).toBe(false); // 14桁
    expect(isValidCorporateNumber13("123456789012")).toBe(false); // 12桁
    expect(isValidCorporateNumber13(null)).toBe(false);
    expect(isValidCorporateNumber13("87001100059A1")).toBe(false);
  });
  it("全角・ハイフン入りの正しい13桁も検証できる", () => {
    expect(isValidCorporateNumber13("８７００１１０００５９０１")).toBe(true);
    expect(isValidCorporateNumber13("8700-1100-05901")).toBe(true);
  });
});

describe("classifyCorporateIdentifier", () => {
  it("12桁 → company_corporate_number_12", () => {
    expect(classifyCorporateIdentifier("700110005901")).toBe(
      "company_corporate_number_12",
    );
    expect(classifyCorporateIdentifier("７００１１０００５９０１")).toBe(
      "company_corporate_number_12",
    );
    expect(classifyCorporateIdentifier("0200-01-012345")).toBe(
      "company_corporate_number_12",
    );
  });
  it("チェックデジット妥当な13桁 → corporate_number_13", () => {
    expect(classifyCorporateIdentifier("8700110005901")).toBe(
      "corporate_number_13",
    );
    expect(classifyCorporateIdentifier("8326405515335")).toBe(
      "corporate_number_13",
    );
  });
  it("チェックデジット不正な13桁 → invalid", () => {
    expect(classifyCorporateIdentifier("1700110005901")).toBe("invalid");
  });
  it("11桁/14桁/数字以外/空 → invalid", () => {
    expect(classifyCorporateIdentifier("70011000590")).toBe("invalid"); // 11桁
    expect(classifyCorporateIdentifier("87001100059012")).toBe("invalid"); // 14桁
    expect(classifyCorporateIdentifier("12A45")).toBe("invalid");
    expect(classifyCorporateIdentifier("")).toBe("invalid");
    expect(classifyCorporateIdentifier(null)).toBe("invalid");
  });
});

describe("12桁→13桁を既存 lookup に渡せる / 混同しない", () => {
  it("12桁から算出した13桁は isValid かつ normalizeCorporateNumber(lookup入力)を通る", () => {
    const c13 = calculateCorporateNumberFromCompanyNumber("326405515335");
    expect(c13).toBe("8326405515335");
    expect(isValidCorporateNumber13(c13!)).toBe(true);
    // 既存の lookup 入口正規化(13桁検証)をそのまま通る＝そのまま国税庁APIに渡せる
    expect(normalizeCorporateNumber(c13!)).toBe("8326405515335");
  });
  it("12桁と13桁を混同しない", () => {
    const twelve = "700110005901";
    // 12桁は corporate_number_13 に分類されない
    expect(classifyCorporateIdentifier(twelve)).toBe(
      "company_corporate_number_12",
    );
    // 12桁は13桁法人番号として妥当でない
    expect(isValidCorporateNumber13(twelve)).toBe(false);
    // 算出結果(13桁)は元の12桁とは別値(先頭にCD付与)
    const thirteen = calculateCorporateNumberFromCompanyNumber(twelve);
    expect(thirteen).not.toBe(twelve);
    expect(thirteen).toHaveLength(13);
    expect(thirteen!.slice(1)).toBe(twelve); // 末尾12桁=基礎番号として保持
    // 既存 normalizeCorporateNumber は 12桁を 13桁化しない(別ロジック非干渉)
    expect(normalizeCorporateNumber(twelve)).toBeNull();
  });
});
