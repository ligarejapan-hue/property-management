import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const schema = read("prisma/schema.prisma");
const sql = read("prisma/migrations/20261003100000_add_dm_batch_unsubscribe/migration.sql");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("宛名CSVの配信停止のスキーマ", () => {
  it("控えに追跡URLの固定値、控えの行に送付記録への結び付き(SetNull)", () => {
    expect(block("DmExportBatch")).toMatch(/unsubscribeBaseUrl\s+String\?\s+@map\("unsubscribe_base_url"\)/);
    const item = block("DmExportBatchItem");
    expect(item).toMatch(/logId\s+String\?\s+@map\("log_id"\) @db\.Uuid/);
    expect(item).toMatch(/log\s+PropertyDmLog\?\s+@relation\(fields: \[logId\], references: \[id\], onDelete: SetNull\)/);
    expect(item).toMatch(/@@index\(\[logId\]\)/);
    expect(block("PropertyDmLog")).toMatch(/batchItems\s+DmExportBatchItem\[\]/);
  });

  it("migration は追加のみ", () => {
    expect(sql).toContain('ALTER TABLE "dm_export_batches" ADD COLUMN "unsubscribe_base_url" TEXT;');
    expect(sql).toContain('ALTER TABLE "dm_export_batch_items" ADD COLUMN "log_id" UUID;');
    expect(sql).toContain('CREATE INDEX "dm_export_batch_items_log_id_idx" ON "dm_export_batch_items"("log_id");');
    expect(sql).toMatch(/ADD CONSTRAINT "dm_export_batch_items_log_id_fkey" FOREIGN KEY \("log_id"\) REFERENCES "property_dm_logs"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE)\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
