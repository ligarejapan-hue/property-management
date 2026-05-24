/**
 * registry-pdf import page F-1: scanned PDF 警告バナーの UI source-assertion テスト。
 *
 * - isLikelyScanned 時にバナーを描画する条件分岐が存在する
 * - 「画像化された謄本PDF」「OCR」「手動」を含む文言を表示する
 * - 警告バナーに data-testid="scanned-pdf-banner" / role="alert" が付与されている
 * - OCR を実装していない（外部 OCR/tesseract 等の import がない）
 * - サーバーレスポンスから extractionSource / isLikelyScanned を受け取る
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/import/registry-pdf/page.tsx",
  ),
  "utf8",
);

describe("import/registry-pdf page F-1 scanned 警告バナー", () => {
  it("isLikelyScanned state を保持している", () => {
    expect(pageSrc).toMatch(/\[\s*isLikelyScanned\s*,\s*setIsLikelyScanned\s*\]/);
  });

  it("isLikelyScanned で条件分岐し data-testid と role=alert を持つバナーを描画する", () => {
    expect(pageSrc).toMatch(
      /\{\s*isLikelyScanned\s*&&[\s\S]{0,400}data-testid=("|')scanned-pdf-banner\1/,
    );
    expect(pageSrc).toMatch(/role=("|')alert\1/);
  });

  it("バナー文言に画像化謄本PDF・OCR未対応・手動確認の表現が含まれる", () => {
    expect(pageSrc).toMatch(/画像化された謄本PDF/);
    expect(pageSrc).toMatch(/OCR/);
    expect(pageSrc).toMatch(/手動/);
  });

  it("parse レスポンスから extractionSource / isLikelyScanned を受け取る", () => {
    expect(pageSrc).toMatch(/extractionSource/);
    expect(pageSrc).toMatch(/isLikelyScanned/);
  });

  it("OCR や外部 OCR ライブラリを import していない", () => {
    expect(pageSrc).not.toMatch(/from\s+("|')tesseract/);
    expect(pageSrc).not.toMatch(/from\s+("|')pdf2pic/);
    expect(pageSrc).not.toMatch(/google[-_.]?cloud.*document/i);
    expect(pageSrc).not.toMatch(/azure.*form.?recognizer/i);
  });
});
