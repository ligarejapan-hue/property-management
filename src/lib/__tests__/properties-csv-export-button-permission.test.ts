/**
 * PR #80 Codex 追加指摘 P2 / P3 の確認。
 *
 * P2: 物件一覧の「CSV出力」ボタンを CSV 出力権限がある場合だけ表示する。
 *     export API が csv_export:read と csv_export_personal:read の両方を必須にしているため、
 *     UI 側も同条件で出し分け、権限が無いユーザーには非表示にする
 *     （クリックして /api/properties/export の JSON エラー画面へ遷移させない）。
 * P3: NEXT_PUBLIC_USE_MOCK=true 時の mock admin 権限に csv_export_personal:read を含める。
 *
 * 既存の properties-page-mgmt-id-ui.test.ts / field-survey-mock-permissions.test.ts と
 * 同じ source-assertion + runtime の方式に合わせる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf8",
);
const apiHelpersSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/lib/api-helpers.ts"),
  "utf8",
);

// ── P2: CSV出力ボタンの権限制御 ─────────────────────────────────────────────

describe("properties page: CSV出力ボタンの権限制御 (P2)", () => {
  it("canExportCsv state を持ち、/api/me/permissions から権限を取得する", () => {
    expect(pageSrc).toMatch(/setCanExportCsv/);
    expect(pageSrc).toMatch(/fetch\("\/api\/me\/permissions"\)/);
  });

  it("csv_export と csv_export_personal の両方を要求する（export API と同条件）", () => {
    expect(pageSrc).toMatch(/has\("csv_export"\)\s*&&\s*has\("csv_export_personal"\)/);
  });

  it("CSV出力ボタンは canExportCsv のときだけレンダリングされる（条件付き表示）", () => {
    // {canExportCsv && ( ... CSV出力 ... )} の形で囲われている
    expect(pageSrc).toMatch(/canExportCsv\s*&&\s*\(/);
    // ボタン文言「CSV出力」が canExportCsv ブロックより後に存在する
    const guardIdx = pageSrc.indexOf("canExportCsv &&");
    const buttonIdx = pageSrc.indexOf("CSV出力");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(guardIdx);
  });

  it("権限取得失敗時は canExportCsv を false にする（誤って遷移させない）", () => {
    expect(pageSrc).toMatch(/catch\([\s\S]*?setCanExportCsv\(false\)/);
  });

  it("既存の新規物件登録ボタン・検索・フィルタ挙動は維持されている", () => {
    // 新規物件登録ボタンはそのまま
    expect(pageSrc).toMatch(/新規物件登録/);
    // CSV export は従来どおり buildFilterParams を引き継ぐ
    expect(pageSrc).toMatch(/handleExportCsv/);
    expect(pageSrc).toMatch(/\/api\/properties\/export/);
  });
});

// ── P3: mock admin 権限 (source assertion) ──────────────────────────────────

describe("api-helpers.ts — mock permission payload (csv_export_personal) (P3)", () => {
  const mockBlock = apiHelpersSrc.match(
    /NEXT_PUBLIC_USE_MOCK[\s\S]*?return\s*\[[\s\S]*?\];/,
  );

  it("mock 配列に csv_export:read/granted=true がある（既存維持）", () => {
    expect(mockBlock).not.toBeNull();
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"csv_export",\s*action:\s*"read",\s*granted:\s*true/,
    );
  });

  it("mock 配列に csv_export_personal:read/granted=true がある（追加）", () => {
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"csv_export_personal",\s*action:\s*"read",\s*granted:\s*true/,
    );
  });
});

// ── P3: mock admin 権限 (runtime) ───────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
    permissionTemplate: { findUnique: vi.fn() },
    userPermission: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { getUserPermissions } from "@/lib/api-helpers";

describe("getUserPermissions — NEXT_PUBLIC_USE_MOCK=true (csv_export_personal) (P3)", () => {
  const prevEnv = process.env.NEXT_PUBLIC_USE_MOCK;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_USE_MOCK = "true";
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.NEXT_PUBLIC_USE_MOCK;
    } else {
      process.env.NEXT_PUBLIC_USE_MOCK = prevEnv;
    }
  });

  it("csv_export:read と csv_export_personal:read が granted=true で返る", async () => {
    const perms = await getUserPermissions("any-user-id");
    for (const resource of ["csv_export", "csv_export_personal"] as const) {
      const entry = perms.find(
        (p) => p.resource === resource && p.action === "read",
      );
      expect(entry, `${resource}:read`).toBeDefined();
      expect(entry?.granted).toBe(true);
    }
  });
});
