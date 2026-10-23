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
