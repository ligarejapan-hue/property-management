import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_KEY_BY_ROUTE } from "@/lib/sale-dm-letter/scenario-resolve";
import { taglineForAutoKey } from "@/lib/sale-dm-letter/scenario-tagline";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20261108100000_dm_scenario_old_house_auto_key/migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const statements = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();

describe("古い家に auto_key を付ける migration(2026-11-08)", () => {
  it("★文は UPDATE 1つだけ(表・列・行の追加や削除をしない)", () => {
    expect(statements).toMatch(/^UPDATE "dm_scenarios" SET "auto_key" = 'old_house'/);
    expect(statements.split(";").filter((s) => s.trim()).length).toBe(1);
    expect(statements).not.toMatch(/\b(INSERT|DELETE|DROP|ALTER|CREATE)\b/i);
  });
  it("★名前ちょうど・削除されていない・auto_key が空 の行がちょうど1件、かつ old_house がまだ無いときだけ", () => {
    expect(statements).toMatch(/WHERE "name" = '古い家' AND "deleted_at" IS NULL AND "auto_key" IS NULL/);
    expect(statements).toMatch(/\(SELECT count\(\*\) FROM "dm_scenarios" WHERE "name" = '古い家' AND "deleted_at" IS NULL AND "auto_key" IS NULL\) = 1/);
    expect(statements).toMatch(/NOT EXISTS \(SELECT 1 FROM "dm_scenarios" WHERE "auto_key" = 'old_house'\)/);
  });
  it("付けるキーは振り分けと添え書きの両方が知っているもの", () => {
    expect(AUTO_KEY_BY_ROUTE.field_survey[0]).toBe("old_house");
    expect(taglineForAutoKey("old_house")).toBe("住まい・不動産のご相談窓口");
  });
});
