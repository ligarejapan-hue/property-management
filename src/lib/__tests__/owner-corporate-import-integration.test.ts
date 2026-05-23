/**
 * Phase D 統合 source-assertion テスト。
 *
 * 3 import 経路（owner_csv / reception-owner / registry-pdf）に法人番号検出ヘルパーが
 * 正しく組み込まれていることを、ソースコードのパターンで検証する。
 * 完全な prisma mock を組まずに「呼び出しが繋がっている」「PII を漏らさない」「サマリが残る」を
 * 担保するための軽量テスト。
 *
 * - 共通ヘルパー decideCorporateImport / corporateImportMessage が各 route から import されている
 * - 新規 Owner 作成 data に corporateNumber を乗せる導線がある（save action のみ）
 * - reception-owner / registry-pdf の reuse パスに updateMany(where: corporateNumber: null) がある
 * - AuditLog detail に corporateNumber: corporateSummary が乗っている
 * - errorMessage への追記が rowCorporateMessage 経由になっている
 * - 生値（13桁数字）や会社名・住所を AuditLog detail に直接乗せていない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ownerCsvSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/import/owner-csv/route.ts"),
  "utf8",
);
const receptionOwnerSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/import/reception-owner/route.ts"),
  "utf8",
);
const registryPdfSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/api/import/registry-pdf/route.ts"),
  "utf8",
);

function expectCommonImport(src: string) {
  expect(src).toMatch(/from\s+"@\/lib\/owner-corporate-import"/);
  expect(src).toMatch(/decideCorporateImport/);
  expect(src).toMatch(/emptyCorporateImportSummary/);
  expect(src).toMatch(/tallyCorporateDecision/);
  expect(src).toMatch(/corporateImportMessage/);
  expect(src).toMatch(/appendImportMessage/);
}

describe("owner-csv route Phase D 統合", () => {
  it("法人番号ヘルパーを import している", () => {
    expectCommonImport(ownerCsvSrc);
  });

  it("decideCorporateImport を呼び出して新規 Owner 作成 data に乗せる", () => {
    expect(ownerCsvSrc).toMatch(/decideCorporateImport\(/);
    // save action のみ data.corporateNumber に乗せる
    expect(ownerCsvSrc).toMatch(
      /cnDecision\.action\s*===\s*"save"[\s\S]{0,150}createData\.corporateNumber\s*=\s*cnDecision\.corporateNumber/,
    );
  });

  it("AuditLog detail に corporateNumber サマリが乗っている", () => {
    expect(ownerCsvSrc).toMatch(/corporateNumber:\s*corporateSummary/);
  });

  it("AuditLog detail に法人番号の生値・会社名・住所・候補リストを直書きしていない", () => {
    // owner_csv_import action のスコープに対して、detail に corporateNumber 関連の
    // 生値 key（rawValue / candidates / record / company / address）が無いこと
    expect(ownerCsvSrc).not.toMatch(/corporateNumberRawValue|corporateCandidates/);
    expect(ownerCsvSrc).not.toMatch(/corporateRecord:/);
  });

  it("errorMessage 追記は appendImportMessage 経由で非PIIメッセージのみ", () => {
    expect(ownerCsvSrc).toMatch(/appendImportMessage\(null,\s*cnMessage\)/);
  });
});

describe("reception-owner route Phase D 統合", () => {
  it("法人番号ヘルパーを import している", () => {
    expectCommonImport(receptionOwnerSrc);
  });

  it("upsertOwnerAndLink に onCorporateDecision コールバック引数がある", () => {
    expect(receptionOwnerSrc).toMatch(/onCorporateDecision\?:/);
  });

  it("reuse パスで updateMany(where corporateNumber:null) による空欄埋め", () => {
    expect(receptionOwnerSrc).toMatch(
      /updateMany\(\{[\s\S]{0,200}corporateNumber:\s*null[\s\S]{0,150}data:\s*\{\s*corporateNumber:\s*cnDecision\.corporateNumber/,
    );
  });

  it("create パスで data.corporateNumber を save action のみ乗せる", () => {
    expect(receptionOwnerSrc).toMatch(
      /cnDecisionForCreate\.action\s*===\s*"save"[\s\S]{0,80}corporateNumber:\s*cnDecisionForCreate\.corporateNumber/,
    );
  });

  it("AuditLog detail に corporateNumber サマリが乗っている", () => {
    expect(receptionOwnerSrc).toMatch(/corporateNumber:\s*corporateSummary/);
  });

  it("行 errorMessage は appendImportMessage 経由で集約", () => {
    expect(receptionOwnerSrc).toMatch(/appendImportMessage\(null,\s*rowCorporateMessage\)/);
  });

  it("既存 Owner select で corporateNumber を取得", () => {
    expect(receptionOwnerSrc).toMatch(
      /select:\s*\{[\s\S]{0,200}corporateNumber:\s*true/,
    );
  });
});

describe("registry-pdf route Phase D 統合", () => {
  it("法人番号ヘルパーを import している", () => {
    expectCommonImport(registryPdfSrc);
  });

  it("parsed.owners[] ループで decideCorporateImport を呼ぶ", () => {
    expect(registryPdfSrc).toMatch(/decideCorporateImport\(/);
  });

  it("reuse パスで updateMany(where corporateNumber:null) による空欄埋め", () => {
    expect(registryPdfSrc).toMatch(
      /updateMany\(\{[\s\S]{0,200}corporateNumber:\s*null[\s\S]{0,150}data:\s*\{\s*corporateNumber:\s*cnDecision\.corporateNumber/,
    );
  });

  it("create パスで data.corporateNumber を save action のみ乗せる", () => {
    expect(registryPdfSrc).toMatch(
      /cnDecision\.action\s*===\s*"save"[\s\S]{0,80}corporateNumber:\s*cnDecision\.corporateNumber/,
    );
  });

  it("AuditLog detail (pdf_import action) に corporateNumber サマリが乗っている", () => {
    expect(registryPdfSrc).toMatch(/corporateNumber:\s*corporateSummary/);
  });

  it("既存 Owner candidates select で corporateNumber を取得", () => {
    expect(registryPdfSrc).toMatch(
      /select:\s*\{[\s\S]{0,200}corporateNumber:\s*true/,
    );
  });

  it("ImportJobRow.errorMessage に rowCorporateMessage を追記", () => {
    expect(registryPdfSrc).toMatch(/appendImportMessage\(null,\s*rowCorporateMessage\)/);
  });

  it("pdf_import の AuditLog action 名を変更していない", () => {
    expect(registryPdfSrc).toMatch(/action:\s*"pdf_import"/);
  });
});

describe("共通: PII 漏洩防止", () => {
  it("3 route いずれも detail に raw XML / rawText / rawData 全文を流していない", () => {
    for (const src of [ownerCsvSrc, receptionOwnerSrc, registryPdfSrc]) {
      // AuditLog の detail オブジェクト周辺で「rawText: rawText」や「rawXml」が無いこと
      expect(src).not.toMatch(/detail:\s*\{[\s\S]{0,400}rawText:/);
      expect(src).not.toMatch(/detail:\s*\{[\s\S]{0,400}rawXml/);
    }
  });

  it("errorMessage 追記文言は固定文字列のみで法人番号を含まない", () => {
    for (const src of [ownerCsvSrc, receptionOwnerSrc, registryPdfSrc]) {
      // owner-corporate-import.ts の corporateImportMessage が返す固定文言以外は使っていない
      // → 法人番号生値を template literal で errorMessage に差し込んでいないこと
      expect(src).not.toMatch(
        /errorMessage:\s*`[^`]*\$\{[^}]*corporateNumber[^}]*\}/,
      );
    }
  });
});
