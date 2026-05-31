/**
 * A-2a: 謄本PDF取込で「confirm 画面の編集結果が確定に反映される」ことと、
 *       parse API の _rawTextPreview 削除を、source-assertion で検証する。
 *
 * 既存の registry-pdf 系テスト（registry-pdf-page-*.test.ts 等）と同じ
 * source-assertion 方式に合わせる。挙動の回帰は既存 parse/import テスト＋
 * フルスイートでカバーする。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const pageSrc = read("src/app/(dashboard)/import/registry-pdf/page.tsx");
const apiClientSrc = read("src/lib/api-client.ts");
const routeSrc = read("src/app/api/import/registry-pdf/route.ts");
const parseRouteSrc = read("src/app/api/import/registry-pdf/parse/route.ts");

// ── A-2a-1: 編集結果を確定APIへ送る ───────────────────────────────────────

describe("A-2a-1 (UI): confirm の編集 fields/owners を確定APIへ送る", () => {
  it("page.tsx が edited(fields + owners) を組み立てる", () => {
    expect(pageSrc).toMatch(/const edited = \{/);
    expect(pageSrc).toMatch(/realEstateNumber: fields\.realEstateNumber\.value/);
    expect(pageSrc).toMatch(/address: fields\.address\.value/);
    expect(pageSrc).toMatch(/landCategory: fields\.landCategory\.value/);
    expect(pageSrc).toMatch(/area: fields\.area\.value/);
    expect(pageSrc).toMatch(/owners: owners\.map\(/);
  });

  it("page.tsx が edited を file/text 両モードの確定APIに渡す", () => {
    expect(pageSrc).toMatch(/importRegistryPdfFile\([\s\S]*?edited,?\s*\)/);
    expect(pageSrc).toMatch(/importRegistryPdf\([\s\S]*?edited,?\s*\)/);
  });
});

describe("A-2a-1 (api-client): edited を JSON / FormData に積む", () => {
  it("importRegistryPdf が edited 引数を受け JSON body に含める", () => {
    expect(apiClientSrc).toMatch(
      /export async function importRegistryPdf\([\s\S]*?edited\?: unknown/,
    );
    expect(apiClientSrc).toMatch(
      /JSON\.stringify\(\{ text, propertyId, fileName, edited \}\)/,
    );
  });

  it("importRegistryPdfFile が edited 引数を受け FormData に積む", () => {
    expect(apiClientSrc).toMatch(
      /export async function importRegistryPdfFile\([\s\S]*?edited\?: unknown/,
    );
    expect(apiClientSrc).toMatch(
      /form\.append\("edited", JSON\.stringify\(edited\)\)/,
    );
  });
});

describe("A-2a-1 (server): 受領値を zod 検証し、再parseより優先", () => {
  it("editedImportSchema(zod) を定義し multipart で parse 検証する", () => {
    expect(routeSrc).toMatch(/const editedImportSchema = z\.object\(/);
    expect(routeSrc).toMatch(/editedImportSchema\.parse\(/);
  });

  it("JSON schema に edited を含める", () => {
    expect(routeSrc).toMatch(/edited: editedImportSchema\.optional\(\)/);
  });

  it("parse 結果に編集値をマージ（編集優先）してから下流で使う", () => {
    expect(routeSrc).toMatch(/function applyEditedToParsed/);
    expect(routeSrc).toMatch(
      /applyEditedToParsed\(parseRegistryText\(text\), edited\)/,
    );
  });

  it("owners は name 空を除外して反映する", () => {
    expect(routeSrc).toMatch(/\.filter\(\(o\) => o\.name\.length > 0\)/);
  });

  it("不正 JSON の edited は 400 で拒否する（multipart）", () => {
    expect(routeSrc).toMatch(/INVALID_EDITED/);
  });
});

// ── Codex対応: 地目 / 地積 も編集値を再parseより優先反映する ─────────────────

describe("A-2a-1 (Codex): landCategory / area も編集値を再parseより優先反映", () => {
  it("editedImportSchema.fields が landCategory / area を受け付ける", () => {
    expect(routeSrc).toMatch(/landCategory: z\.string\(\)\.nullish\(\)/);
    expect(routeSrc).toMatch(/area: z\.string\(\)\.nullish\(\)/);
  });

  it("applyEditedToParsed が landCategory を編集値（nz 正規化）で上書きする", () => {
    expect(routeSrc).toMatch(
      /parsed\.landCategory = nz\(edited\.fields\.landCategory\)/,
    );
  });

  it("applyEditedToParsed が area を編集値（nz 正規化）で上書きする", () => {
    expect(routeSrc).toMatch(/parsed\.area = nz\(edited\.fields\.area\)/);
  });
});

// ── PII / AuditLog 据置 ───────────────────────────────────────────────────

describe("A-2a-1 (PII): AuditLog に所有者名/住所/本文を増やさない", () => {
  it("route の writeAuditLog detail に rawText / 所有者名配列を入れない", () => {
    expect(routeSrc).not.toMatch(/rawText/);
    // AuditLog detail に owners 名や address を直接載せていないこと
    expect(routeSrc).not.toMatch(/detail:\s*\{[\s\S]*?ownerNames/);
  });
});

// ── A-2a-2: parse API の _rawTextPreview 削除 ─────────────────────────────

describe("A-2a-2: parse API レスポンスから _rawTextPreview を削除", () => {
  it("parse route に _rawTextPreview が存在しない", () => {
    expect(parseRouteSrc).not.toMatch(/_rawTextPreview/);
  });
});
