/**
 * 21-C PR-1: postalCode 追加 migration が「properties / buildings への postal_code 2列
 * 追加(nullable ADD COLUMN)だけ」で、backfill や他の DDL を含まないことを source assertion で固定。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const MIGRATION =
  "prisma/migrations/20260612000000_add_property_building_postal_code/migration.sql";

describe("postalCode migration（21-C PR-1）", () => {
  it("migration ファイルが存在する", () => {
    expect(existsSync(resolve(process.cwd(), MIGRATION))).toBe(true);
  });

  it("properties / buildings に postal_code を nullable ADD COLUMN する 2 文だけ", () => {
    const sql = readFileSync(resolve(process.cwd(), MIGRATION), "utf8");
    const statements = sql
      .split(";")
      .map((s) => s.replace(/--.*$/gm, "").trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(2);
    expect(statements).toContain(
      'ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "postal_code" TEXT',
    );
    expect(statements).toContain(
      'ALTER TABLE "buildings" ADD COLUMN IF NOT EXISTS "postal_code" TEXT',
    );
  });

  it("backfill / 破壊的 DDL を含まない（UPDATE/DROP/NOT NULL/DEFAULT/CREATE TABLE なし）", () => {
    // コメントを除いた実 SQL だけで判定（コメント中の語に反応しない）。
    const ddl = readFileSync(resolve(process.cwd(), MIGRATION), "utf8")
      .replace(/--.*$/gm, "")
      .trim();
    expect(ddl).not.toMatch(/\bUPDATE\b/i);
    expect(ddl).not.toMatch(/\bDROP\b/i);
    expect(ddl).not.toMatch(/\bNOT NULL\b/i);
    expect(ddl).not.toMatch(/\bDEFAULT\b/i);
    expect(ddl).not.toMatch(/\bCREATE TABLE\b/i);
  });
});
