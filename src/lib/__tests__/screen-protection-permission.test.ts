/**
 * S1b-1: 画面保護(screen_protection) / 謄本PDF(registry_pdf) 権限の土台を検証する。
 *
 * 採用権限（最小3点）:
 *   - screen_protection:bypass … 管理者用 のみ付与（未付与=保護対象、fail-safe）
 *   - registry_pdf:preview      … 現地担当用 / 事務担当用 / 管理者用 の全3テンプレ
 *   - registry_pdf:download     … 現地担当用 / 事務担当用 / 管理者用 の全3テンプレ
 *     （既存の謄本PDF 閲覧/DL 挙動を将来の enforcement 導入時も壊さないための現行相当付与）
 *
 * 本 PR は権限の「定義・付与・admin UI 表示・mock・backfill migration」のみ。
 * 透かし Provider / コピー・印刷抑止 / registry PDF の preview・download enforcement /
 * /uploads route 変更 / /api/me/permissions 変更 は一切含まない（後続 PR）。
 *
 * 既存 registry-auto-fetch-permission.test.ts と同じ source-assertion 方式。
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
const migrationSrc = read(
  "prisma/migrations/20260603000000_add_screen_protection_permissions/migration.sql",
);

describe("S1b-1: seed.ts の権限定義", () => {
  it("1. screen_protection:bypass は admin テンプレートに付与されている", () => {
    expect(seedSrc).toMatch(
      /templateId: adminTemplate\.id, resource: "screen_protection", action: "bypass", granted: true/,
    );
  });

  it("2a. screen_protection は office_staff に付与していない（fail-safe）", () => {
    expect(seedSrc).not.toMatch(
      /officeStaffTemplate\.id, resource: "screen_protection"/,
    );
  });

  it("2b. screen_protection は field_staff に付与していない（fail-safe）", () => {
    expect(seedSrc).not.toMatch(
      /fieldStaffTemplate\.id, resource: "screen_protection"/,
    );
  });

  it("3. registry_pdf:preview は全3テンプレートに付与されている", () => {
    expect(seedSrc).toMatch(
      /templateId: fieldStaffTemplate\.id, resource: "registry_pdf", action: "preview", granted: true/,
    );
    expect(seedSrc).toMatch(
      /templateId: officeStaffTemplate\.id, resource: "registry_pdf", action: "preview", granted: true/,
    );
    expect(seedSrc).toMatch(
      /templateId: adminTemplate\.id, resource: "registry_pdf", action: "preview", granted: true/,
    );
  });

  it("4. registry_pdf:download は全3テンプレートに付与されている（現地担当も現状維持）", () => {
    expect(seedSrc).toMatch(
      /templateId: fieldStaffTemplate\.id, resource: "registry_pdf", action: "download", granted: true/,
    );
    expect(seedSrc).toMatch(
      /templateId: officeStaffTemplate\.id, resource: "registry_pdf", action: "download", granted: true/,
    );
    expect(seedSrc).toMatch(
      /templateId: adminTemplate\.id, resource: "registry_pdf", action: "download", granted: true/,
    );
  });
});

describe("S1b-1: mock(admin 相当) の権限", () => {
  it("screen_protection:bypass / registry_pdf:preview / registry_pdf:download がある", () => {
    expect(apiHelpersSrc).toMatch(
      /resource:\s*"screen_protection",\s*action:\s*"bypass",\s*granted:\s*true/,
    );
    expect(apiHelpersSrc).toMatch(
      /resource:\s*"registry_pdf",\s*action:\s*"preview",\s*granted:\s*true/,
    );
    expect(apiHelpersSrc).toMatch(
      /resource:\s*"registry_pdf",\s*action:\s*"download",\s*granted:\s*true/,
    );
  });
});

describe("S1b-1: 権限編集UI のラベル表示", () => {
  it("5a. users 権限編集UI に screen_protection / registry_pdf が日本語ラベルで追加されている", () => {
    expect(usersPermPageSrc).toMatch(
      /key: "screen_protection", label: "画面保護", actions: \["bypass"\]/,
    );
    expect(usersPermPageSrc).toMatch(
      /key: "registry_pdf", label: "謄本PDF", actions: \["preview", "download"\]/,
    );
  });

  it("5b. templates 編集UI に screen_protection / registry_pdf が日本語ラベルで追加されている", () => {
    expect(templatesPageSrc).toMatch(
      /key: "screen_protection", label: "画面保護", actions: \["bypass"\]/,
    );
    expect(templatesPageSrc).toMatch(
      /key: "registry_pdf", label: "謄本PDF", actions: \["preview", "download"\]/,
    );
  });

  it("5c. 両ページに bypass / preview / download のアクション和名がある", () => {
    for (const src of [usersPermPageSrc, templatesPageSrc]) {
      expect(src).toMatch(/bypass: "保護免除"/);
      expect(src).toMatch(/preview: "プレビュー"/);
      expect(src).toMatch(/download: "ダウンロード"/);
    }
  });

  it("5d. 既存リソースのラベル(謄本自動取得/インポート/監査ログ)が壊れていない", () => {
    for (const src of [usersPermPageSrc, templatesPageSrc]) {
      expect(src).toMatch(/key: "registry", label: "謄本自動取得"/);
      expect(src).toMatch(/key: "import", label: "インポート"/);
      expect(src).toMatch(/key: "audit_log", label: "監査ログ"/);
    }
  });
});

describe("S1b-1: hasPermission で自然に判定できる（default-deny）", () => {
  it("screen_protection:bypass=granted なら true", () => {
    expect(
      hasPermission(
        [{ resource: "screen_protection", action: "bypass", granted: true }],
        "screen_protection",
        "bypass",
      ),
    ).toBe(true);
  });

  it("付与が無ければ既定 deny(false) = 保護対象", () => {
    expect(hasPermission([], "screen_protection", "bypass")).toBe(false);
  });

  it("granted=false なら false", () => {
    expect(
      hasPermission(
        [{ resource: "registry_pdf", action: "download", granted: false }],
        "registry_pdf",
        "download",
      ),
    ).toBe(false);
  });
});

describe("S1b-1: 既存DB向け idempotent backfill migration", () => {
  it("1. template_permissions への INSERT である", () => {
    expect(migrationSrc).toMatch(/INSERT INTO "template_permissions"/);
  });

  it("2. screen_protection:bypass は 管理者用 のみに投入する", () => {
    expect(migrationSrc).toMatch(/'screen_protection', 'bypass', true/);
    expect(migrationSrc).toMatch(/pt\."name" = '管理者用'/);
  });

  it("3. registry_pdf:preview / download を全3テンプレートに投入する", () => {
    expect(migrationSrc).toMatch(/'registry_pdf', 'preview', true/);
    expect(migrationSrc).toMatch(/'registry_pdf', 'download', true/);
    expect(migrationSrc).toMatch(
      /pt\."name" IN \('現地担当用', '事務担当用', '管理者用'\)/,
    );
  });

  it("4. ON CONFLICT DO NOTHING で idempotent（重複作成しない）", () => {
    expect(migrationSrc).toMatch(
      /ON CONFLICT \("template_id", "resource", "action"\) DO NOTHING/,
    );
  });

  it("5. 列は id/template_id/resource/action/granted のみ（created_at/updated_at を入れない）", () => {
    expect(migrationSrc).toMatch(
      /\("id", "template_id", "resource", "action", "granted"\)/,
    );
    expect(migrationSrc).not.toMatch(/created_at|updated_at/);
  });

  it("6. 正規化 template_permissions のみ対象（permission_templates 本体/JSON blob は更新しない）", () => {
    expect(migrationSrc).not.toMatch(/UPDATE "permission_templates"/);
    expect(migrationSrc).not.toMatch(/INSERT INTO "permission_templates"/);
  });

  it("7. DDL/PII が混入していない（データのみの migration）", () => {
    expect(migrationSrc).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE/i);
  });

  it("8. seed.ts と migration が矛盾しない（admin の screen_protection:bypass）", () => {
    expect(seedSrc).toMatch(
      /templateId: adminTemplate\.id, resource: "screen_protection", action: "bypass", granted: true/,
    );
    expect(migrationSrc).toMatch(/'screen_protection', 'bypass', true/);
  });
});

describe("S1b-1: スコープ限定（土台のみ・enforcement なし）", () => {
  it("変更ファイルに enforcement/透かし/抑止系の実装が混入していない", () => {
    for (const src of [
      seedSrc,
      apiHelpersSrc,
      usersPermPageSrc,
      templatesPageSrc,
      migrationSrc,
    ]) {
      expect(src).not.toMatch(/ScreenProtectionProvider|WatermarkOverlay/);
      expect(src).not.toMatch(/user-select/);
      expect(src).not.toMatch(/Content-Disposition/);
      expect(src).not.toMatch(/onbeforeprint|oncontextmenu/);
      expect(src).not.toMatch(/audit-events/);
      expect(src).not.toMatch(/pdf-lib/);
    }
  });
});
