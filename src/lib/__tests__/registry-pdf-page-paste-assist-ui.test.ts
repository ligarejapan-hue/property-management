/**
 * Phase F-2a UI source-assertion テスト。
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

describe("registry-pdf page Phase F-2a 強化 UI", () => {
  it("scanned 警告バナーは既存 data-testid を維持する（F-1 互換）", () => {
    expect(pageSrc).toMatch(/data-testid="scanned-pdf-banner"/);
    expect(pageSrc).toMatch(/画像化された謄本PDFの可能性があります/);
  });

  it("F-2a: バナー文言に OCR 未対応の明示と外部 OCR 誘導が含まれる", () => {
    expect(pageSrc).toMatch(/OCR.{0,3}未対応/);
    expect(pageSrc).toMatch(/外部のOCRツール|外部OCR/);
    expect(pageSrc).toMatch(/手動/);
  });

  it("F-2a: 「テキストを貼り付けるモードに切り替える」ボタンがある", () => {
    expect(pageSrc).toMatch(/data-testid="scanned-pdf-switch-to-paste"/);
    expect(pageSrc).toMatch(/テキストを貼り付けるモードに切り替える/);
  });

  it("F-2a: 切替ボタンは paste タブに切り替え、text を空にする（不完全 embedded_text を投入しない）", () => {
    const buttonMatch = pageSrc.match(
      /scanned-pdf-switch-to-paste[\s\S]{0,1200}<\/button>/,
    );
    expect(buttonMatch).not.toBeNull();
    const body = buttonMatch?.[0] ?? "";
    expect(body).toMatch(/setUploadTab\("text"\)/);
    expect(body).toMatch(/setText\(""\)/);
    expect(body).toMatch(/setSelectedFile\(null\)/);
    expect(body).toMatch(/setIsLikelyScanned\(false\)/);
    expect(body).not.toMatch(/setText\(text\)/);
    expect(body).not.toMatch(/setText\(extracted/);
  });

  it("F-2a: parse response の extraction.source / embeddedTextLength を読む", () => {
    expect(pageSrc).toMatch(/extraction\?\.source\s*===\s*"likely_scanned"/);
    expect(pageSrc).toMatch(/extraction\?\.embeddedTextLength/);
    expect(pageSrc).toMatch(/setEmbeddedTextLength/);
  });

  it("F-2a: 抽出文字数のみ画面表示（本文・raw text は持ち出さない）", () => {
    expect(pageSrc).toMatch(/抽出文字数:\s*\{embeddedTextLength\}\s*文字/);
    expect(pageSrc).not.toMatch(/_rawTextPreview/);
    expect(pageSrc).not.toMatch(/result\.rawText/);
  });

  it("ローカル OCR エンジン（tesseract/sharp）はページに同梱せず、OCR は localhost サービスへ委譲する", () => {
    // ブラウザ内 OCR 実行や OCR エンジンの同梱はしない（PII egress 防止・bundle 肥大回避）。
    expect(pageSrc).not.toMatch(/tesseract/i);
    expect(pageSrc).not.toMatch(/from\s+"sharp"/);
    // OCR は gated client(requestRegistryOcrDraft)経由でサーバ route へ委譲する。
    expect(pageSrc).toMatch(/requestRegistryOcrDraft/);
  });

  it("F-2a: 既存 isLikelyScanned 後方互換読みも残す", () => {
    expect(pageSrc).toMatch(/result\.isLikelyScanned\s*===\s*true/);
  });
});
