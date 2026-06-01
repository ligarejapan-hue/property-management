/**
 * PR2: 謄本自動取得連携の権限土台 registry:auto_fetch を検証する。
 *
 * - seed.ts の正規化 templateEntries で admin のみに registry:auto_fetch が付与され、
 *   office_staff / field_staff には付与されていないこと（課金を伴う高リスク操作のため安全側）。
 * - api-helpers の mock(admin 相当) に registry:auto_fetch があること。
 * - 権限編集UI(RESOURCES) に registry が日本語ラベルで追加され、既存ラベルが壊れないこと。
 * - 既存の hasPermission(perms, "registry", "auto_fetch") で自然に判定できること。
 *
 * 本 PR では自動取得 API / UIボタン / provider / 外部接続 / env は追加しない（土台のみ）。
 * 既存 registry-pdf 系テストと同じ source-assertion 方式。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { hasPermission } from "@/lib/permissions";

const read = (p: string) =>
  fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

const seedSrc = read("prisma/seed.ts");
const apiHelpersSrc = read("src/lib/api-helpers.ts");
const usersPermPageSrc = read(
  "src/app/(dashboard)/admin/users/[id]/permissions/page.tsx",
);
const templatesPageSrc = read(
  "src/app/(dashboard)/admin/templates/[id]/page.tsx",
);
// CodexP2: 既存本番DB向けの idempotent backfill migration。
const migrationSrc = read(
  "prisma/migrations/20260601000000_add_registry_auto_fetch_permission/migration.sql",
);

describe("PR2: registry:auto_fetch の権限定義", () => {
  it("1. resource=registry / action=auto_fetch が定義されている", () => {
    expect(seedSrc).toMatch(/resource: "registry", action: "auto_fetch"/);
  });

  it("2. admin テンプレートに registry:auto_fetch(granted=true) が含まれる", () => {
    expect(seedSrc).toMatch(
      /templateId: adminTemplate\.id, resource: "registry", action: "auto_fetch", granted: true/,
    );
  });

  it("3a. office_staff には registry 権限を付与していない", () => {
    expect(seedSrc).not.toMatch(
      /officeStaffTemplate\.id, resource: "registry"/,
    );
  });

  it("3b. field_staff には registry 権限を付与していない", () => {
    expect(seedSrc).not.toMatch(/fieldStaffTemplate\.id, resource: "registry"/);
  });

  it("mock(admin 相当) に registry:auto_fetch がある", () => {
    expect(apiHelpersSrc).toMatch(
      /resource:\s*"registry",\s*action:\s*"auto_fetch",\s*granted:\s*true/,
    );
  });
});

describe("PR2: 権限編集UI のラベル表示", () => {
  it("5a. users 権限編集UI に registry が日本語ラベルで追加されている", () => {
    expect(usersPermPageSrc).toMatch(
      /key: "registry", label: "謄本自動取得", actions: \["auto_fetch"\]/,
    );
  });

  it("5b. templates 編集UI に registry が日本語ラベルで追加されている", () => {
    expect(templatesPageSrc).toMatch(
      /key: "registry", label: "謄本自動取得", actions: \["auto_fetch"\]/,
    );
  });

  it("5c. 既存リソースのラベル(インポート/監査ログ)が壊れていない", () => {
    for (const src of [usersPermPageSrc, templatesPageSrc]) {
      expect(src).toMatch(/key: "import", label: "インポート"/);
      expect(src).toMatch(/key: "audit_log", label: "監査ログ"/);
    }
  });
});

describe("PR2: hasPermission で自然に判定できる", () => {
  it("registry:auto_fetch=granted なら true", () => {
    expect(
      hasPermission(
        [{ resource: "registry", action: "auto_fetch", granted: true }],
        "registry",
        "auto_fetch",
      ),
    ).toBe(true);
  });

  it("付与が無ければ既定 deny(false)", () => {
    expect(hasPermission([], "registry", "auto_fetch")).toBe(false);
  });

  it("granted=false なら false", () => {
    expect(
      hasPermission(
        [{ resource: "registry", action: "auto_fetch", granted: false }],
        "registry",
        "auto_fetch",
      ),
    ).toBe(false);
  });
});

describe("PR2/CodexP2: 既存DB向け idempotent backfill migration", () => {
  it("1. 管理者用テンプレートに registry/auto_fetch/granted=true を投入する", () => {
    expect(migrationSrc).toMatch(/'registry', 'auto_fetch', true/);
    expect(migrationSrc).toMatch(/pt\."name" = '管理者用'/);
    expect(migrationSrc).toMatch(/INSERT INTO "template_permissions"/);
  });

  it("2. office_staff(事務担当用) / field_staff(現地担当用) には投入しない", () => {
    expect(migrationSrc).not.toMatch(/事務担当用/);
    expect(migrationSrc).not.toMatch(/現地担当用/);
  });

  it("3. ON CONFLICT DO NOTHING で idempotent（重複作成しない）", () => {
    expect(migrationSrc).toMatch(
      /ON CONFLICT \("template_id", "resource", "action"\) DO NOTHING/,
    );
  });

  it("4. seed.ts と migration が矛盾しない（どちらも admin に registry:auto_fetch=true）", () => {
    expect(seedSrc).toMatch(
      /templateId: adminTemplate\.id, resource: "registry", action: "auto_fetch", granted: true/,
    );
    expect(migrationSrc).toMatch(/'registry', 'auto_fetch', true/);
  });

  it("正規化 template_permissions のみ対象（permission_templates 本体/JSON blob は更新しない）", () => {
    expect(migrationSrc).not.toMatch(/UPDATE "permission_templates"/);
    expect(migrationSrc).not.toMatch(/INSERT INTO "permission_templates"/);
  });

  it("DDL/外部接続/PII/env が混入していない（データのみの migration）", () => {
    expect(migrationSrc).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
    expect(migrationSrc).not.toMatch(
      /RegistryFetchProvider|REGISTRY_API_KEY|playwright/i,
    );
  });
});

describe("PR2: スコープ限定（土台のみ・外部接続なし）", () => {
  it("provider/外部API key/playwright が混入していない", () => {
    for (const src of [
      seedSrc,
      apiHelpersSrc,
      usersPermPageSrc,
      templatesPageSrc,
    ]) {
      expect(src).not.toMatch(/RegistryFetchProvider/);
      expect(src).not.toMatch(/REGISTRY_API_KEY|REGISTRY_API_URL/);
      expect(src).not.toMatch(/playwright/i);
    }
  });
});
