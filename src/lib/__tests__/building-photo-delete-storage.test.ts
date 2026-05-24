/**
 * source-assertion: DELETE /api/buildings/[id]/photos/[photoId] が
 * DB 削除成功後に storage.delete を best-effort で呼び、失敗しても
 * 既存成功レスポンスを維持し、fileUrl / key を console / AuditLog に
 * 生値で残さないことを保証する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const routeSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/api/buildings/[id]/photos/[photoId]/route.ts",
  ),
  "utf8",
);

describe("BuildingPhoto DELETE — storage cleanup", () => {
  it("getStorage と extractStorageKeyFromUrl を import している", () => {
    expect(routeSrc).toMatch(/from\s+"@\/lib\/storage"/);
    expect(routeSrc).toMatch(/from\s+"@\/lib\/storage\/url-to-key"/);
    expect(routeSrc).toMatch(/extractStorageKeyFromUrl/);
    expect(routeSrc).toMatch(/getStorage/);
  });

  it("DB 削除前に fileUrl を捕捉している", () => {
    const dbDeleteIdx = routeSrc.search(
      /prisma\.buildingPhoto\.delete\(\{\s*where:\s*\{\s*id:\s*photoId/,
    );
    expect(dbDeleteIdx).toBeGreaterThan(0);
    const beforeDelete = routeSrc.slice(0, dbDeleteIdx);
    expect(beforeDelete).toMatch(/photo\.fileUrl/);
  });

  it("DB 削除成功後に storage.delete を呼ぶ順序", () => {
    const dbDeleteIdx = routeSrc.search(
      /prisma\.buildingPhoto\.delete\(/,
    );
    const storageDeleteIdx = routeSrc.search(/getStorage\(\)\.delete\(/);
    expect(dbDeleteIdx).toBeGreaterThan(0);
    expect(storageDeleteIdx).toBeGreaterThan(dbDeleteIdx);
  });

  it("storage.delete を try/catch で囲む (best-effort)", () => {
    const blockMatch = routeSrc.match(
      /try\s*\{[\s\S]*?getStorage\(\)\.delete\([\s\S]*?\}\s*catch\s*\(([\s\S]*?)\)\s*\{[\s\S]*?console\.error/,
    );
    expect(blockMatch).not.toBeNull();
  });

  it("console.error に fileUrl / key 生値を埋め込まない", () => {
    const errorCallMatch = routeSrc.match(
      /console\.error\([\s\S]*?storage\.delete\s+failed[\s\S]*?\}\);/,
    );
    expect(errorCallMatch).not.toBeNull();
    const body = errorCallMatch![0];
    expect(body).not.toMatch(/fileUrl/);
    expect(body).not.toMatch(/storageKey/);
    expect(body).not.toMatch(/\bkey\s*:/);
  });

  it("AuditLog detail に fileUrl / storageKey を入れない", () => {
    const detailMatch = routeSrc.match(
      /writeAuditLog\(\{[\s\S]*?detail:\s*\{([\s\S]*?)\}/,
    );
    expect(detailMatch).not.toBeNull();
    const body = detailMatch![1];
    expect(body).not.toMatch(/fileUrl/);
    expect(body).not.toMatch(/storageKey/);
  });

  it("既存成功レスポンス (apiResponse with message) を維持", () => {
    expect(routeSrc).toMatch(/apiResponse\(\{\s*message:\s*"削除しました"\s*\}\)/);
  });

  it("extractStorageKeyFromUrl が null の場合は storage.delete を呼ばない (skip ガード)", () => {
    expect(routeSrc).toMatch(/storageKey\s*!=\s*null/);
  });
});
