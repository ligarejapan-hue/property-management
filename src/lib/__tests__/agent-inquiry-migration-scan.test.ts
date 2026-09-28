import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const sql = read("prisma/migrations/20260928100000_add_agent_inquiries/migration.sql");

describe("反響の受付 migration(設計 §1/§4)", () => {
  it("4表を作る", () => {
    for (const t of ["agents", "agent_inquiries", "agent_viewings", "property_ad_permissions"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
    }
  });
  it("反響→物件・業者は RESTRICT、内見→反響は CASCADE、広告の可否→物件は CASCADE", () => {
    expect(sql).toMatch(/"agent_inquiries_property_id_fkey" FOREIGN KEY \("property_id"\) REFERENCES "properties"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/"agent_inquiries_agent_id_fkey" FOREIGN KEY \("agent_id"\) REFERENCES "agents"\("id"\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/"agent_viewings_inquiry_id_fkey" FOREIGN KEY \("inquiry_id"\) REFERENCES "agent_inquiries"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"property_ad_permissions_property_id_fkey" FOREIGN KEY \("property_id"\) REFERENCES "properties"\("id"\) ON DELETE CASCADE/);
  });
  it("内見の予定にも版番号(同時編集の上書き防止)", () => {
    expect(sql).toMatch(/CREATE TABLE "agent_viewings" \([^;]*"version" INTEGER NOT NULL DEFAULT 1/);
  });
  it("広告の可否は物件×媒体で一意", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "property_ad_permissions_property_id_medium_key" ON "property_ad_permissions"\("property_id", "medium"\);/);
  });
  it("3テンプレートに agent_inquiry read/write を付与(重複しない)", () => {
    for (const a of ["read", "write"]) {
      expect(sql).toMatch(new RegExp(`'agent_inquiry', '${a}', true[\\s\\S]*?IN \\('管理者用', '事務担当用', '現地担当用'\\)[\\s\\S]*?ON CONFLICT \\("template_id", "resource", "action"\\) DO NOTHING`));
    }
  });
  it("既存の行を書き換えない", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/im);
  });
  it("既存の表の列を変えない(ALTER TABLE は外部キーの追加だけ)", () => {
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)" ([A-Z ]+)/g)) {
      expect(m[2], `${m[1]} ${m[2]}`).toMatch(/^ADD CONSTRAINT/);
    }
  });
});

describe("権限の一覧は2画面で同じ(片方だけだと付与できない)", () => {
  it("templates と users の RESOURCES に agent_inquiry read/write", () => {
    for (const p of [
      "src/app/(dashboard)/admin/templates/[id]/page.tsx",
      "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/\{ key: "agent_inquiry", label: "反響の受付", actions: \["read", "write"\] \}/);
    }
  });
  it("seed で3テンプレートに付与", () => {
    const seed = read("prisma/seed.ts");
    for (const t of ["fieldStaffTemplate", "officeStaffTemplate", "adminTemplate"]) {
      for (const a of ["read", "write"]) {
        expect(seed).toContain(`{ templateId: ${t}.id, resource: "agent_inquiry", action: "${a}", granted: true }`);
      }
    }
  });
});
