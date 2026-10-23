/**
 * 「今も効力のある登記」の要約（rights）の配線と、PII を漏らさない作りの固定。
 * 既存の parse route テストと同じく、ソースの形を確かめる。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
const routeSrc = read("src/app/api/import/registry-pdf/parse/route.ts");
const moduleSrcs = ["index.ts", "extract.ts", "analyze.ts", "lines.ts"].map((f) =>
  read(`src/lib/registry-strike/${f}`),
);

describe("registry-pdf parse route: rights の配線", () => {
  it("プレビュー応答に rights を含める", () => {
    expect(routeSrc).toMatch(/summarizeRegistryRights\(\{\s*pdf:\s*pdfBuffer,\s*text\s*\}\)/);
    expect(routeSrc).toMatch(/parsed,\s*rights,/);
  });

  it("画像だけのPDF（likely_scanned）では作らない", () => {
    expect(routeSrc).toMatch(/const rights = isLikelyScanned\s*\?\s*null/);
  });

  it("プレビュー専用: rights を DB 書き込みや AuditLog に使わない", () => {
    expect(routeSrc).not.toMatch(/prisma\./);
    expect(routeSrc).not.toMatch(/auditLog\.create|createAuditLog|writeAuditLog/i);
  });
});

describe("registry-strike: 氏名・住所・本文をログに出さない", () => {
  it("console 出力をしない", () => {
    for (const src of moduleSrcs) expect(src).not.toMatch(/console\./);
  });

  it("失敗は null にして例外の中身を返さない", () => {
    const index = moduleSrcs[0];
    expect(index).toMatch(/catch \{\s*\n\s*\/\/[^\n]*\n\s*return null;/);
  });
});

describe("registry-strike: ページ上限", () => {
  it("上限を超えるPDFは途中までで判定せず、失敗（null）にする", () => {
    const extract = read("src/lib/registry-strike/extract.ts");
    expect(extract).toMatch(/if \(doc\.numPages > MAX_PAGES\) \{\s*\n\s*throw/);
    expect(extract).not.toMatch(/Math\.min\(doc\.numPages, MAX_PAGES\)/);
  });
});

describe("registry-pdf parse route: 全部事項の所有者", () => {
  it("全部事項なら、確認画面の所有者を判定結果で埋める（判定できなければ空＋警告）", () => {
    expect(routeSrc).toMatch(/if \(isFullCertificateText\(text\)\) \{\s*\n\s*if \(rights && hasDeterminedOwners\(rights\)\) \{\s*\n\s*parsed\.owners = ownersFromRights\(rights\);/);
    expect(routeSrc).toMatch(/parsed\.owners = \[\];\s*\n\s*parsed\.warnings = \[\.\.\.parsed\.warnings, FULL_CERTIFICATE_PREVIEW_WARNING\]/);
    // 確認の要る注記がある判定は、下書きとして見せて注意を出す
    expect(routeSrc).toMatch(/parsed\.warnings = \[\.\.\.parsed\.warnings, FULL_CERTIFICATE_REVIEW_WARNING\]/);
  });
});
