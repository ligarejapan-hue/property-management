/**
 * Phase F-2a parse route source-assertion テスト。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const routeSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/api/import/registry-pdf/parse/route.ts",
  ),
  "utf8",
);

describe("registry-pdf parse route Phase F-2a response shape", () => {
  it("既存 extractionSource / isLikelyScanned が apiResponse に含まれる（後方互換）", () => {
    expect(routeSrc).toMatch(/extractionSource,/);
    expect(routeSrc).toMatch(/isLikelyScanned,/);
  });

  it("F-2a: 新 extraction.source / extraction.embeddedTextLength が含まれる", () => {
    expect(routeSrc).toMatch(
      /extraction:\s*\{[\s\S]{0,200}source:\s*extractionSource[\s\S]{0,200}embeddedTextLength:\s*text\.length/,
    );
  });

  it("A-2a-2/F-2a: raw text 本文を非デバッグレスポンスに含めない", () => {
    // A-2a-2: _rawTextPreview（dev限定の本文先頭600字=PII断片）は廃止済み。不在を固定する。
    expect(routeSrc).not.toMatch(/_rawTextPreview/);
    expect(routeSrc).not.toMatch(/text:\s*text,/);
    expect(routeSrc).not.toMatch(/rawText:\s*text/);
  });

  it("F-2a: OCR / tesseract / sharp 等の依存 import を追加していない", () => {
    expect(routeSrc).not.toMatch(/from\s+"tesseract/i);
    expect(routeSrc).not.toMatch(/from\s+"sharp"/);
    expect(routeSrc).not.toMatch(/from\s+"@google-cloud\/vision"/);
    expect(routeSrc).not.toMatch(/textract/i);
  });

  it("F-2a: 本登録ルート (/api/import/registry-pdf) には触れていない", () => {
    expect(routeSrc).not.toMatch(/\/api\/import\/registry-pdf"/);
  });
});
