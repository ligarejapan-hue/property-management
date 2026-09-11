import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf-8").replace(/\r\n/g, "\n");
const slice = (from: string, to: string) => schema.slice(schema.indexOf(from), schema.indexOf(to));
const asset = slice("model DmLpAsset {", "model DmLpVariantMedia {");
const media = slice("model DmLpVariantMedia {", "model SaleDmConfig {");
const sql = readFileSync(
  path.resolve(process.cwd(), "prisma/migrations/20260910100000_add_dm_lp_assets/migration.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("DmLpAsset / DmLpVariantMedia の表", () => {
  it("DmLpVariant の後・SaleDmConfig の前に並ぶ", () => {
    const a = schema.indexOf("model DmLpVariant {");
    const b = schema.indexOf("model DmLpAsset {");
    const c = schema.indexOf("model DmLpVariantMedia {");
    const d = schema.indexOf("model SaleDmConfig {");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
  });
  it("DmLpAsset: publicId は @unique、寸法と保存キーを持つ、論理削除列がある", () => {
    expect(asset).toMatch(/publicId\s+String\s+@unique\s+@map\("public_id"\)/);
    for (const col of ["storageKey", "mime", "width", "height", "bytes", "createdBy", "deletedAt"]) {
      expect(asset, `${col} が無い`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(asset).toMatch(/@@map\("dm_lp_assets"\)/);
  });
  it("DmLpVariantMedia: 枠(slot)・小見出し・写真か図のどちらか・LP型ごとの索引", () => {
    for (const col of ["lpVariantId", "slot", "heading", "assetId", "figureKind", "sortOrder"]) {
      expect(media, `${col} が無い`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(media).toMatch(/@@index\(\[lpVariantId\]\)/);
    expect(media).toMatch(/@@index\(\[assetId\]\)/);
    expect(media).toMatch(/@@map\("dm_lp_variant_media"\)/);
  });
  it("migration は additive のみ(文頭の UPDATE/DELETE/DROP を含まない)", () => {
    expect(sql).toMatch(/CREATE TABLE "dm_lp_assets"/);
    expect(sql).toMatch(/CREATE TABLE "dm_lp_variant_media"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_lp_assets_public_id_key"/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/m);
  });
});
