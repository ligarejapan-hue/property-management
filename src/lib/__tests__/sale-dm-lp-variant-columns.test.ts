import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf-8").replace(/\r\n/g, "\n");
const lp = schema.slice(schema.indexOf("model DmLpVariant {"), schema.indexOf("model SaleDmConfig {"));
const draft = schema.slice(schema.indexOf("model DmRecipientDraft {"), schema.indexOf("model DmLpVariant {"));
const sql = readFileSync(
  path.resolve(process.cwd(), "prisma/migrations/20260909000000_add_dm_lp_variants/migration.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

describe("DmLpVariant(LP型)の表", () => {
  it("DmRecipientDraft の後・SaleDmConfig の前に置く(既存走査の切り出しを壊さない)", () => {
    const a = schema.indexOf("model DmRecipientDraft {");
    const b = schema.indexOf("model DmLpVariant {");
    const c = schema.indexOf("model SaleDmConfig {");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
  it("文体4項目・プロンプト控え・原文・切り分け結果・凍結印を持つ", () => {
    for (const col of ["tone", "length", "appeal", "strength", "promptText", "rawTemplate", "headline", "lead", "bodyText", "faqJson", "templateFrozenAt"]) {
      expect(lp, `${col} が無い`).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(lp).toMatch(/@@map\("dm_lp_variants"\)/);
    expect(lp).toMatch(/@@index\(\[campaignId\]\)/);
  });
  it("宛先の lpVariantId は nullable(既存行を壊さない)", () => {
    expect(draft).toMatch(/lpVariantId\s+String\?\s+@map\("lp_variant_id"\)/);
    expect(draft).toMatch(/@@index\(\[lpVariantId\]\)/);
  });
  it("migration は additive のみ(UPDATE/DELETE/DROP/NOT NULL 追加を含まない)", () => {
    expect(sql).toMatch(/CREATE TABLE "dm_lp_variants"/);
    expect(sql).toMatch(/ADD COLUMN "lp_variant_id" UUID;/);
    expect(sql).toMatch(/ON DELETE CASCADE/); // campaign 削除で LP型も消える
    // 文頭の UPDATE/DELETE/DROP だけを禁止(FK の "ON UPDATE CASCADE" / "ON DELETE SET NULL" は許可)。
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/m);
    expect(sql).not.toMatch(/ALTER TABLE "dm_recipient_drafts"[^;]*NOT NULL/);
  });
});
