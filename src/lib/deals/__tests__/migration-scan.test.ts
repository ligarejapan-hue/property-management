import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INITIAL_RATE_TABLES } from "../rate-tables";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20261024100000_add_deals/migration.sql");

describe("取引の migration(設計 §2)", () => {
  it("5表を作る", () => {
    for (const t of ["deals", "deal_parties", "deal_documents", "deal_settings", "deal_rate_tables"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
    }
  });
  it("取引番号は一意・版の番号を持つ", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "deals_deal_no_key" ON "deals"\("deal_no"\);/);
    expect(sql).toMatch(/CREATE TABLE "deals" \([^;]*"version" INTEGER NOT NULL DEFAULT 1/);
    expect(sql).toMatch(/CREATE TABLE "deal_parties" \([^;]*"version" INTEGER NOT NULL DEFAULT 1/);
  });
  it("物件・担当を消しても取引は残る(空欄に戻す)・当事者は取引と一緒に消える・発行履歴は取引を消させない", () => {
    expect(sql).toMatch(/"deals_property_id_fkey" FOREIGN KEY \("property_id"\) REFERENCES "properties"\("id"\) ON DELETE SET NULL/);
    expect(sql).toMatch(/"deals_assignee_id_fkey" FOREIGN KEY \("assignee_id"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/);
    expect(sql).toMatch(/"deal_parties_deal_id_fkey" FOREIGN KEY \("deal_id"\) REFERENCES "deals"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"deal_documents_deal_id_fkey" FOREIGN KEY \("deal_id"\) REFERENCES "deals"\("id"\) ON DELETE RESTRICT/);
  });
  it("税率の初期データは INITIAL_RATE_TABLES と同じ", () => {
    const rows = [...sql.matchAll(/\('([a-z_]+)', DATE '(\d{4}-\d{2}-\d{2})', (NULL|DATE '\d{4}-\d{2}-\d{2}'), '([^']+)'::jsonb\)/g)].map((m) => ({
      kind: m[1], validFrom: m[2], validTo: m[3] === "NULL" ? null : m[3].slice(6, 16), content: JSON.parse(m[4]),
    }));
    expect(rows).toEqual(INITIAL_RATE_TABLES);
  });
  it("3テンプレートに deal read/write を付与(重複しない)", () => {
    for (const a of ["read", "write"]) {
      expect(sql).toMatch(new RegExp(`'deal', '${a}', true[\\s\\S]*?IN \\('管理者用', '事務担当用', '現地担当用'\\)[\\s\\S]*?ON CONFLICT \\("template_id", "resource", "action"\\) DO NOTHING`));
    }
  });
  it("既存の行を書き換えない・既存の表の列を変えない", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)" ([A-Z ]+)/g)) {
      expect(m[1], m[1]).toMatch(/^deal/);
      expect(m[2], `${m[1]} ${m[2]}`).toMatch(/^ADD CONSTRAINT/);
    }
  });
});

describe("権限 deal の配線", () => {
  it("2つの権限画面の RESOURCES に同じ行", () => {
    for (const p of [
      "src/app/(dashboard)/admin/templates/[id]/page.tsx",
      "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
    ]) {
      expect(read(p), p).toContain('{ key: "deal", label: "取引", actions: ["read", "write"] }');
    }
  });
  it("seed で3テンプレートに付与・mock にもある", () => {
    const seed = read("prisma/seed.ts");
    for (const t of ["fieldStaffTemplate", "officeStaffTemplate", "adminTemplate"]) {
      for (const a of ["read", "write"]) {
        expect(seed).toContain(`{ templateId: ${t}.id, resource: "deal", action: "${a}", granted: true }`);
      }
    }
    const helpers = read("src/lib/api-helpers.ts");
    expect(helpers).toContain('{ resource: "deal", action: "read", granted: true }');
    expect(helpers).toContain('{ resource: "deal", action: "write", granted: true }');
  });
});
