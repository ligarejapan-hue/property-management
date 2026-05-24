/**
 * isLikelyScannedPdf / getPdfExtractionSource: 単体テスト
 *
 * 画像化PDF（スキャン謄本）の可能性を判定する純関数のテスト。
 * OCR は未実装のため、UI 警告用途のみで利用される。
 */
import { describe, it, expect } from "vitest";
import {
  SCANNED_PDF_TEXT_LENGTH_THRESHOLD,
  getPdfExtractionSource,
  isLikelyScannedPdf,
} from "@/lib/pdf-extract";

describe("isLikelyScannedPdf", () => {
  it("空文字列は likely_scanned とみなす", () => {
    expect(isLikelyScannedPdf("")).toBe(true);
  });

  it("whitespace のみは likely_scanned とみなす", () => {
    expect(isLikelyScannedPdf("   \n\t  \r\n")).toBe(true);
    expect(isLikelyScannedPdf("　　")).toBe(true);
  });

  it("閾値未満の極端に短いテキストは likely_scanned とみなす", () => {
    expect(isLikelyScannedPdf("不動産番号")).toBe(true);
    expect(isLikelyScannedPdf("a".repeat(SCANNED_PDF_TEXT_LENGTH_THRESHOLD - 1))).toBe(
      true,
    );
  });

  it("閾値以上のテキストは likely_scanned ではない", () => {
    const longText =
      "不動産番号 1234567890123\n所在 東京都千代田区丸の内一丁目\n地番 1番1\n地目 宅地\n地積 150.00\n所有者 山田太郎";
    expect(longText.length).toBeGreaterThanOrEqual(SCANNED_PDF_TEXT_LENGTH_THRESHOLD);
    expect(isLikelyScannedPdf(longText)).toBe(false);
  });

  it("非 string 入力は安全側に倒して likely_scanned とみなす", () => {
    expect(isLikelyScannedPdf(undefined as unknown as string)).toBe(true);
    expect(isLikelyScannedPdf(null as unknown as string)).toBe(true);
  });
});

describe("getPdfExtractionSource", () => {
  it("空文字列は likely_scanned を返す", () => {
    expect(getPdfExtractionSource("")).toBe("likely_scanned");
  });

  it("十分なテキストは embedded_text を返す", () => {
    const longText = "x".repeat(SCANNED_PDF_TEXT_LENGTH_THRESHOLD + 10);
    expect(getPdfExtractionSource(longText)).toBe("embedded_text");
  });
});
