import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const schema = read("prisma/schema.prisma");
const sql = read("prisma/migrations/20261005100000_add_dm_letter_illustration/migration.sql");
const block = (name: string) => {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name}`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
};

describe("手紙のイラストのスキーマ", () => {
  it("台帳と発送の型に写真への参照(Restrict)と索引", () => {
    const s = block("DmScenario");
    expect(s).toMatch(/letterIllustrationAssetId\s+String\?\s+@map\("letter_illustration_asset_id"\) @db\.Uuid/);
    expect(s).toMatch(/letterIllustrationAsset\s+DmLpAsset\?\s+@relation\("ScenarioLetterIllustration", fields: \[letterIllustrationAssetId\], references: \[id\], onDelete: Restrict\)/);
    expect(s).toMatch(/@@index\(\[letterIllustrationAssetId\]\)/);
    const v = block("DmVariant");
    expect(v).toMatch(/illustrationAssetId\s+String\?\s+@map\("illustration_asset_id"\) @db\.Uuid/);
    expect(v).toMatch(/illustrationAsset\s+DmLpAsset\?\s+@relation\("VariantIllustration", fields: \[illustrationAssetId\], references: \[id\], onDelete: Restrict\)/);
    expect(v).toMatch(/@@index\(\[illustrationAssetId\]\)/);
    const a = block("DmLpAsset");
    expect(a).toMatch(/scenarioLetterIllustrations\s+DmScenario\[\]\s+@relation\("ScenarioLetterIllustration"\)/);
    expect(a).toMatch(/variantIllustrations\s+DmVariant\[\]\s+@relation\("VariantIllustration"\)/);
  });

  it("migration は追加のみ", () => {
    expect(sql).toContain('ALTER TABLE "dm_scenarios" ADD COLUMN "letter_illustration_asset_id" UUID;');
    expect(sql).toContain('ALTER TABLE "dm_variants" ADD COLUMN "illustration_asset_id" UUID;');
    expect(sql).toContain('CREATE INDEX "dm_scenarios_letter_illustration_asset_id_idx" ON "dm_scenarios"("letter_illustration_asset_id");');
    expect(sql).toContain('CREATE INDEX "dm_variants_illustration_asset_id_idx" ON "dm_variants"("illustration_asset_id");');
    expect(sql).toMatch(/ADD CONSTRAINT "dm_scenarios_letter_illustration_asset_id_fkey" FOREIGN KEY \("letter_illustration_asset_id"\) REFERENCES "dm_lp_assets"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/);
    expect(sql).toMatch(/ADD CONSTRAINT "dm_variants_illustration_asset_id_fkey" FOREIGN KEY \("illustration_asset_id"\) REFERENCES "dm_lp_assets"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE)\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
