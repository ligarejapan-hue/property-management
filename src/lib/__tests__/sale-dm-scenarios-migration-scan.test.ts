import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20260927100000_add_dm_scenarios/migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("DMの種類 migration(設計 §3.1)", () => {
  it("台帳を指す4列はすべて ON DELETE RESTRICT", () => {
    for (const [table, col] of [
      ["properties", "dm_scenario_id"],
      ["dm_campaigns", "default_scenario_id"],
      ["dm_variants", "scenario_id"],
      ["dm_lp_variants", "scenario_id"],
    ]) {
      const re = new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${col}_fkey" FOREIGN KEY \\("${col}"\\) REFERENCES "dm_scenarios"\\("id"\\) ON DELETE RESTRICT`);
      expect(sql, `${table}.${col}`).toMatch(re);
    }
  });
  it("写しの一意(発送×種類)と名前の一意は部分一意索引", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_variants_campaign_scenario_uniq"\s+ON "dm_variants"\("campaign_id", "scenario_id"\)\s+WHERE "scenario_id" IS NOT NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_lp_variants_campaign_scenario_uniq"\s+ON "dm_lp_variants"\("campaign_id", "scenario_id"\)\s+WHERE "scenario_id" IS NOT NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_scenarios_name_live_uniq"\s+ON "dm_scenarios"\("name"\)\s+WHERE "deleted_at" IS NULL;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_scenarios_auto_key_key" ON "dm_scenarios"\("auto_key"\);/);
  });
  it("最初の2件(相続/空き家)を auto_key 付きで入れる", () => {
    expect(sql).toMatch(/INSERT INTO "dm_scenarios"[\s\S]*'相続'[\s\S]*'inheritance'/);
    expect(sql).toMatch(/INSERT INTO "dm_scenarios"[\s\S]*'空き家'[\s\S]*'vacant'/);
  });
  it("写真と図の行は台帳を親に CASCADE・写真へは RESTRICT", () => {
    expect(sql).toMatch(/"dm_scenario_media_scenario_id_fkey" FOREIGN KEY \("scenario_id"\) REFERENCES "dm_scenarios"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"dm_scenario_media_asset_id_fkey" FOREIGN KEY \("asset_id"\) REFERENCES "dm_lp_assets"\("id"\) ON DELETE RESTRICT/);
  });
  it("既存の行を書き換えない(UPDATE/DELETE/DROP を含まない)", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
  });
});
