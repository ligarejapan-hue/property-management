/**
 * 設計ファイル(schema.prisma)の初期値を、migration を順に当てた実際のデータベースに合わせたもの
 * (2026-09-29)。以前は7つの表で食い違い、`prisma migrate dev` が「データベースを作り直せ」と
 * 言い出して開発用の DB で作業が詰まっていた。本番も migration どおり(読み取りで確認済み)。
 *
 * - 6か所: データベース側が id(gen_random_uuid())・更新日時(CURRENT_TIMESTAMP)の初期値を持つ
 * - sale_dm_config.id: データベースに初期値が無い(アプリは作るときに必ず id を渡す)
 *
 * 確かめ方: `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma`
 * (作業用の shadow DB が要る)が空であること。CI に DB は無いので、ここでは設計ファイルの記述を固定する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8").replace(/\r\n/g, "\n");

function modelBlock(table: string): string {
  const mapAt = schema.indexOf(`@@map("${table}")`);
  expect(mapAt, table).toBeGreaterThan(0);
  const start = schema.lastIndexOf("\nmodel ", mapAt);
  return schema.slice(start, mapAt);
}

describe("schema.prisma の初期値は実際のデータベースと同じ", () => {
  it.each(["owner_memos", "property_investigation_audit_logs", "property_investigations", "sales_sheet_designs"])(
    "%s.id はデータベースの gen_random_uuid()",
    (table) => {
      expect(modelBlock(table)).toContain('@id @default(dbgenerated("gen_random_uuid()")) @db.Uuid');
    },
  );

  it.each(["property_dm_logs", "property_investigations", "property_owners"])(
    "%s.updated_at はデータベースの初期値(now)を持つ",
    (table) => {
      expect(modelBlock(table)).toContain('@default(now()) @updatedAt @map("updated_at")');
    },
  );

  it("sale_dm_config.id は初期値を持たない(アプリが必ず id を渡す)", () => {
    const block = modelBlock("sale_dm_config");
    expect(block).toMatch(/\n\s+id\s+String\s+@id\n/);
    expect(block).not.toContain('@default("singleton")');
  });
});
