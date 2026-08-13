import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR-D2(外部AI方式)が使う列を先に足しておく(expand)。この PR では書き手を作らない。
const schema = readFileSync(
  path.resolve(process.cwd(), "prisma/schema.prisma"),
  "utf-8",
);
const model = schema.slice(
  schema.indexOf("model DmVariant {"),
  schema.indexOf("model DmRecipientDraft {"),
);

describe("DmVariant: 外部AI方式の列(PR-D2で使用)", () => {
  it("promptText / bodyTemplate / templateFrozenAt をすべて持つ", () => {
    expect(model).toMatch(/promptText\s+String\?\s+@map\("prompt_text"\)/);
    expect(model).toMatch(/bodyTemplate\s+String\?\s+@map\("body_template"\)/);
    expect(model).toMatch(
      /templateFrozenAt\s+DateTime\?\s+@map\("template_frozen_at"\)/,
    );
  });

  it("すべて nullable(既存行を壊さない・バックフィルしない)", () => {
    for (const col of ["promptText", "bodyTemplate", "templateFrozenAt"]) {
      const line = model.split("\n").find((l) => l.includes(col));
      expect(line, `${col} の行が無い`).toBeDefined();
      expect(line).toMatch(/\?/);
      expect(line).not.toMatch(/@default/);
    }
  });

  it("migration は ADD COLUMN だけ(UPDATE/backfill を含まない)", () => {
    const sql = readFileSync(
      path.resolve(
        process.cwd(),
        "prisma/migrations/20260813000000_add_dm_variant_template/migration.sql",
      ),
      "utf-8",
    );
    expect(sql).toMatch(/ADD COLUMN "prompt_text"/);
    expect(sql).toMatch(/ADD COLUMN "body_template"/);
    expect(sql).toMatch(/ADD COLUMN "template_frozen_at"/);
    expect(sql).not.toMatch(/UPDATE|DELETE|NOT NULL|DROP/i);
  });
});
