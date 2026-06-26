/**
 * Codex P1: import-rollback.ts は Prisma runtime を間接的にも読み込まない。
 *
 * import-rollback.ts は pure helper module として使われるため、
 * change-log.ts (Prisma を import している) や、prisma / db / server-only
 * を import しないことを source-assertion で担保する。
 *
 * 同様に、新規 Prisma-free 定数モジュール (property-field-constants.ts) も
 * Prisma runtime を一切引き込まないことを担保する。
 *
 * 加えて、定数値 (PROPERTY_TRACKED_FIELDS / OWNER_TRACKED_FIELDS /
 * BUILDING_TRACKED_FIELDS) が既存期待値から変わっていないことを検証する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  PROPERTY_TRACKED_FIELDS,
  OWNER_TRACKED_FIELDS,
  BUILDING_TRACKED_FIELDS,
} from "@/lib/property-field-constants";
import * as changeLogModule from "@/lib/change-log";

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

const rollbackSrc = readSrc("src/lib/import-rollback.ts");
const constantsSrc = readSrc("src/lib/property-field-constants.ts");

describe("import-rollback.ts は Prisma-free (Codex P1)", () => {
  it("change-log を import していない", () => {
    expect(rollbackSrc).not.toMatch(
      /from\s+("|')\.\/change-log\1/,
    );
    expect(rollbackSrc).not.toMatch(
      /from\s+("|')@\/lib\/change-log\1/,
    );
  });

  it("prisma / db / server-only / next/server を import していない", () => {
    expect(rollbackSrc).not.toMatch(/from\s+("|')@\/lib\/prisma\1/);
    expect(rollbackSrc).not.toMatch(/from\s+("|')@prisma\/client\1/);
    expect(rollbackSrc).not.toMatch(/from\s+("|')server-only\1/);
    expect(rollbackSrc).not.toMatch(/from\s+("|')next\/server\1/);
    // db client / auth / api route 系も巻き込まない
    expect(rollbackSrc).not.toMatch(/from\s+("|')@\/lib\/audit\1/);
    expect(rollbackSrc).not.toMatch(/from\s+("|')@\/lib\/api-helpers\1/);
  });

  it("PROPERTY_TRACKED_FIELDS を property-field-constants から import している", () => {
    expect(rollbackSrc).toMatch(
      /import\s*\{\s*PROPERTY_TRACKED_FIELDS\s*\}\s*from\s+("|')\.\/property-field-constants\1/,
    );
  });
});

describe("property-field-constants.ts は Prisma-free (Codex P1)", () => {
  it("import 文をひとつも持たない（純定数のみ）", () => {
    expect(constantsSrc).not.toMatch(/^\s*import\s/m);
  });

  it("prisma / db / server-only / next を import / require していない", () => {
    // doc コメントに "Prisma" の文字が出るのは OK。import 文の経路だけを禁じる。
    expect(constantsSrc).not.toMatch(/from\s+("|')[^"']*prisma/i);
    expect(constantsSrc).not.toMatch(/require\s*\(\s*("|')[^"']*prisma/i);
    expect(constantsSrc).not.toMatch(/from\s+("|')server-only\1/);
    expect(constantsSrc).not.toMatch(/from\s+("|')next\//);
  });

  it("PROPERTY_TRACKED_FIELDS の中身は既存と同一 (29 項目・21-C PR-3c で postalCode 追加)", () => {
    expect(PROPERTY_TRACKED_FIELDS).toEqual([
      "propertyType",
      "address",
      "postalCode",
      "lotNumber",
      "buildingNumber",
      "realEstateNumber",
      "registryStatus",
      "dmStatus",
      "caseStatus",
      "introductionRoute",
      "gpsLat",
      "gpsLng",
      "zoningDistrict",
      "buildingCoverageRatio",
      "floorAreaRatio",
      "heightDistrict",
      "firePreventionZone",
      "scenicRestriction",
      "roadType",
      "roadWidth",
      "frontageWidth",
      "frontageDirection",
      "setbackRequired",
      "rosenkaValue",
      "rosenkaYear",
      "rebuildPermission",
      "architectureNote",
      "note",
      "assignedTo",
    ]);
  });

  it("OWNER_TRACKED_FIELDS の中身 (9 項目・21-D Phase3 で companyRegistryNumber 追加)", () => {
    expect(OWNER_TRACKED_FIELDS).toEqual([
      "name",
      "nameKana",
      "phone",
      "zip",
      "address",
      "note",
      "email",
      "corporateNumber",
      "companyRegistryNumber",
    ]);
  });

  it("BUILDING_TRACKED_FIELDS の中身 (13 項目・21-C PR-1 で postalCode 追加)", () => {
    expect(BUILDING_TRACKED_FIELDS).toEqual([
      "name",
      "address",
      "postalCode",
      "lotNumber",
      "realEstateNumber",
      "totalFloors",
      "totalUnits",
      "builtYear",
      "structureType",
      "managementCompany",
      "gpsLat",
      "gpsLng",
      "note",
    ]);
  });
});

describe("change-log.ts は後方互換で同名 export を維持する", () => {
  it("PROPERTY_TRACKED_FIELDS / OWNER_TRACKED_FIELDS / BUILDING_TRACKED_FIELDS を export している", () => {
    expect(changeLogModule.PROPERTY_TRACKED_FIELDS).toEqual(
      PROPERTY_TRACKED_FIELDS,
    );
    expect(changeLogModule.OWNER_TRACKED_FIELDS).toEqual(OWNER_TRACKED_FIELDS);
    expect(changeLogModule.BUILDING_TRACKED_FIELDS).toEqual(
      BUILDING_TRACKED_FIELDS,
    );
  });

  it("recordChanges 関数も維持されている (export 存在)", () => {
    expect(typeof changeLogModule.recordChanges).toBe("function");
  });
});
