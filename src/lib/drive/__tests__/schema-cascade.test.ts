/**
 * Google ドライブの紐づけ(property_drive_folders)は、物件を消す経路のどれでも邪魔をしない(@codex #577 P1)。
 * 物件を消す経路は2つ(物件の削除・取込の取り消し)あり、将来も増え得る。紐づけはアプリ側の記録だけなので、
 * 外部キーを ON DELETE CASCADE にして、どの経路でも物件と一緒に消える(RESTRICT だと取込の取り消しが
 * 外部キー違反で止まり、同じジョブの関係ない行まで巻き戻る)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

describe("property_drive_folders の外部キー", () => {
  it("★migration: property_id の外部キーは ON DELETE CASCADE", () => {
    const sql = read("prisma/migrations/20261024300000_drive_integration/migration.sql");
    const fk = /ADD CONSTRAINT "property_drive_folders_property_id_fkey"[\s\S]*?;/.exec(sql)?.[0] ?? "";
    expect(fk).toContain('REFERENCES "properties"("id")');
    expect(fk).toContain("ON DELETE CASCADE");
  });

  it("★schema: PropertyDriveFolder.property は onDelete: Cascade(migration と食い違わない)", () => {
    const schema = read("prisma/schema.prisma");
    const model = /model PropertyDriveFolder \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toMatch(/property\s+Property\s+@relation\(fields: \[propertyId\], references: \[id\], onDelete: Cascade\)/);
  });
});
