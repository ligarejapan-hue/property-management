import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isPublicPath } from "@/proxy";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");

describe("広告用の公開ページ(設計 2026-10-20) migration", () => {
  const sql = read("prisma/migrations/20261020090000_lp_public_page/migration.sql");
  it("DMの種類に公開名(一意)・申込の表に出どころと広告の印・宛先は NULL 可+どちらか必須の CHECK", () => {
    expect(sql).toMatch(/ALTER TABLE "dm_scenarios" ADD COLUMN "public_slug" TEXT;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "dm_scenarios_public_slug_key" ON "dm_scenarios"\("public_slug"\);/);
    expect(sql).toMatch(/ALTER TABLE "dm_inquiries" ALTER COLUMN "draft_id" DROP NOT NULL;/);
    for (const col of ["scenario_id", "public_slug", "property_address", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"]) {
      expect(sql, col).toMatch(new RegExp(`ADD COLUMN "${col}" (TEXT|UUID)`));
    }
    expect(sql).toMatch(/ADD COLUMN "source" TEXT NOT NULL DEFAULT 'dm'/);
    expect(sql).toMatch(/ADD CONSTRAINT "dm_inquiries_scenario_id_fkey" FOREIGN KEY \("scenario_id"\) REFERENCES "dm_scenarios"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/ADD CONSTRAINT "dm_inquiries_origin_check" CHECK \("draft_id" IS NOT NULL OR "scenario_id" IS NOT NULL\)/);
    expect(sql).toMatch(/ALTER TABLE "sale_dm_config" ADD COLUMN "google_tag_id" TEXT,\s*ADD COLUMN "google_conv_label" TEXT;/);
  });
  it("消す・壊す文は無い(足すだけ)", () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
  });
  it("schema.prisma と対応している(宛先は任意・出どころ・公開名・Google の2列)", () => {
    const schema = read("prisma/schema.prisma");
    expect(schema).toMatch(/draftId\s+String\?\s+@map\("draft_id"\)/);
    expect(schema).toMatch(/draft\s+DmRecipientDraft\?\s+@relation/);
    expect(schema).toMatch(/scenario\s+DmScenario\?\s+@relation\(fields: \[scenarioId\], references: \[id\], onDelete: Restrict\)/);
    expect(schema).toMatch(/publicSlug\s+String\?\s+@unique @map\("public_slug"\)/);
    expect(schema).toMatch(/googleTagId\s+String\?\s+@map\("google_tag_id"\)/);
    expect(schema).toMatch(/googleConvLabel\s+String\?\s+@map\("google_conv_label"\)/);
  });
});

describe("広告用の公開ページの公開パス", () => {
  it("/lp/<公開名> とその受け口は公開(認証不要)", () => {
    expect(isPublicPath("/lp/souzoku")).toBe(true);
    expect(isPublicPath("/lp/souzoku/inquiry")).toBe(true);
  });
  it("管理画面の LPメニュー(/lp 完全一致)と近接パスは公開しない", () => {
    expect(isPublicPath("/lp")).toBe(false);
    expect(isPublicPath("/lpx")).toBe(false);
    expect(isPublicPath("/api/lp/x")).toBe(false);
  });
  it("⚠(dashboard)/lp の下に画面を増やすと /lp/ の前方一致で公開されてしまう=直下は page.tsx だけ", () => {
    const entries = readdirSync(join(process.cwd(), "src/app/(dashboard)/lp"), { withFileTypes: true });
    expect(entries.map((e) => e.name).sort()).toEqual(["page.tsx"]);
  });
});

describe("nginx の設定例(公開ホストは公開の道だけを出す)", () => {
  const conf = read("deploy/nginx/property-management.conf.example");
  it("/lp/ の location が 443 側にある(無いと公開ドメインで 404 になる=2026-10-20 に実際に起きた)", () => {
    const https = conf.slice(conf.indexOf("# HTTPS"));
    expect(https).toMatch(/location \^~ \/lp\/ \{/);
    expect(https).toMatch(/location \^~ \/lp\/ \{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/);
  });
  it("/lp/ も /t/ と同じくアクセスログ・エラーログに残さない(query の utm_* は訪問者が自由に書ける文字列=@codex #535 P2)", () => {
    const https = conf.slice(conf.indexOf("# HTTPS"));
    const start = https.indexOf("location ^~ /lp/ {");
    const block = https.slice(start, https.indexOf("\n    }", start));
    expect(block).toMatch(/access_log off;/);
    expect(block).toMatch(/error_log \/dev\/null crit;/);
  });
  it("docs/deploy.md に公開ホストへ /lp/ を足す手順がある", () => {
    expect(read("docs/deploy.md")).toContain("location ^~ /lp/");
  });
});
