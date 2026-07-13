/**
 * 取込ガード(割れた会社法人等番号の修復)の統合 source-assertion テスト。
 *
 * owner-csv / reception-owner の 2 import 経路に修復ヘルパー
 * (repairSplitCorporateImportRow)が正しく組み込まれていることを、
 * Phase D(owner-corporate-import-integration.test.ts)と同じ流儀で
 * ソースコードのパターンで検証する。
 *
 * - 共通ヘルパーが各 route から import されている
 * - 修復が重複判定・既存Owner検索より前に適用されている
 * - 新規 Owner 作成 data に復元した 12/13桁を乗せる導線がある
 *   (テキスト検出 cnDecision が優先・復元値はフォールバック)
 * - reception-owner の reuse パスに corporateNumber:null ガード付き
 *   updateMany で復元値を埋める導線がある
 * - AuditLog detail に corporateRepair サマリ(件数のみ)が乗っている
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

function expectGuardImport(src: string) {
  expect(src).toMatch(/from\s+"@\/lib\/corporate-number-restore"/);
  expect(src).toMatch(/repairSplitCorporateImportRow/);
  expect(src).toMatch(/emptyCorporateRepairSummary/);
  expect(src).toMatch(/tallyCorporateRepair/);
}

describe("owner-csv route 取込ガード統合", () => {
  it("修復ヘルパーを import している", () => {
    expectGuardImport(ownerCsvSrc);
  });

  it("修復を重複判定より前に適用している", () => {
    const repairIdx = ownerCsvSrc.indexOf("repairSplitCorporateImportRow({");
    const dedupIdx = ownerCsvSrc.indexOf("Duplicate check");
    expect(repairIdx).toBeGreaterThan(0);
    expect(dedupIdx).toBeGreaterThan(0);
    expect(repairIdx).toBeLessThan(dedupIdx);
  });

  it("修復結果を mapped.name / mapped.address に反映している", () => {
    expect(ownerCsvSrc).toMatch(/mapped\.name\s*=\s*repair\.name/);
    expect(ownerCsvSrc).toMatch(/mapped\.address\s*=\s*repair\.address/);
  });

  it("新規作成 data に復元 13桁(フォールバック)と 12桁を乗せている", () => {
    expect(ownerCsvSrc).toMatch(
      /createData\.corporateNumber\s*=\s*repair\.corporateNumber13/,
    );
    expect(ownerCsvSrc).toMatch(
      /createData\.companyRegistryNumber\s*=\s*repair\.companyRegistryNumber12/,
    );
    // テキスト検出(cnDecision save)が優先されること(else if でフォールバック)
    expect(ownerCsvSrc).toMatch(
      /cnDecision\.action\s*===\s*"save"[\s\S]{0,200}else if \(repair\.corporateNumber13\)/,
    );
  });

  it("AuditLog detail に corporateRepair サマリ(件数のみ)が乗っている", () => {
    expect(ownerCsvSrc).toMatch(/corporateRepair:\s*corporateRepairSummary/);
  });
});

describe("reception-owner route 取込ガード統合", () => {
  it("修復ヘルパーを import している", () => {
    expectGuardImport(receptionOwnerSrc);
  });

  it("修復を既存Owner検索より前に適用している(upsertOwnerAndLink 冒頭)", () => {
    const fnIdx = receptionOwnerSrc.indexOf("async function upsertOwnerAndLink");
    const repairIdx = receptionOwnerSrc.indexOf(
      "repairSplitCorporateImportRow({",
      fnIdx,
    );
    const searchIdx = receptionOwnerSrc.indexOf("既存 Owner 検索", fnIdx);
    expect(fnIdx).toBeGreaterThan(0);
    expect(repairIdx).toBeGreaterThan(fnIdx);
    expect(searchIdx).toBeGreaterThan(repairIdx);
  });

  it("reuse パスに corporateNumber:null ガード付きで復元値を埋める導線がある", () => {
    expect(receptionOwnerSrc).toMatch(
      /repair\.corporateNumber13[\s\S]{0,400}where:\s*\{\s*id:\s*candidateOwnerId!,\s*corporateNumber:\s*null\s*\}[\s\S]{0,200}corporateNumber:\s*repair\.corporateNumber13/,
    );
  });

  it("新規作成 data に復元 13桁(フォールバック)と 12桁を乗せている", () => {
    expect(receptionOwnerSrc).toMatch(
      /:\s*repair\.corporateNumber13\s*\n?\s*\?\s*\{\s*corporateNumber:\s*repair\.corporateNumber13\s*\}/,
    );
    expect(receptionOwnerSrc).toMatch(
      /companyRegistryNumber:\s*repair\.companyRegistryNumber12/,
    );
  });

  it("AuditLog detail に corporateRepair サマリ(件数のみ)が乗っている", () => {
    expect(receptionOwnerSrc).toMatch(/corporateRepair:\s*corporateRepairSummary/);
  });
});

describe("PII 安全性", () => {
  it.each([
    ["owner-csv", ownerCsvSrc],
    ["reception-owner", receptionOwnerSrc],
  ])("%s: audit detail に修復の生値(氏名・住所・番号)を直書きしていない", (_n, src) => {
    expect(src).not.toMatch(/corporateRepair:\s*\{[\s\S]{0,120}(name|address|repairedName)/);
    expect(src).not.toMatch(/repairedOwners:/);
  });
});
