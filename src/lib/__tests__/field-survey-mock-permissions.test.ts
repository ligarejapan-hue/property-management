/**
 * NEXT_PUBLIC_USE_MOCK=true 時の mock permission payload に
 * field_survey の 4 action (read/write/read_all/manage) が含まれることを確認する。
 *
 * 背景: Phase 1-A で field_survey 権限を追加したが、mock mode の hardcoded
 * permission に該当エントリが無いと、ローカル mock 環境で /api/field-survey/sessions
 * が常に 403 になり開発時動作確認できない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── source assertion ────────────────────────────────────────────────────────

const apiHelpersSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/lib/api-helpers.ts"),
  "utf8",
);

describe("api-helpers.ts — mock permission payload (field_survey)", () => {
  const mockBlock = apiHelpersSrc.match(
    /NEXT_PUBLIC_USE_MOCK[\s\S]*?return\s*\[[\s\S]*?\];/,
  );

  it("mock 配列に field_survey:read/granted=true がある", () => {
    expect(mockBlock).not.toBeNull();
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"field_survey",\s*action:\s*"read",\s*granted:\s*true/,
    );
  });

  it("mock 配列に field_survey:write/granted=true がある", () => {
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"field_survey",\s*action:\s*"write",\s*granted:\s*true/,
    );
  });

  it("mock 配列に field_survey:read_all/granted=true がある", () => {
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"field_survey",\s*action:\s*"read_all",\s*granted:\s*true/,
    );
  });

  it("mock 配列に field_survey:manage/granted=true がある", () => {
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"field_survey",\s*action:\s*"manage",\s*granted:\s*true/,
    );
  });
});

// ── runtime: getUserPermissions(NEXT_PUBLIC_USE_MOCK=true) ──────────────────

vi.mock("@/lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn() },
    permissionTemplate: { findUnique: vi.fn() },
    userPermission: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { getUserPermissions } from "@/lib/api-helpers";

describe("getUserPermissions — NEXT_PUBLIC_USE_MOCK=true (field_survey)", () => {
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

  it("field_survey の 4 action がすべて granted=true で返る", async () => {
    const perms = await getUserPermissions("any-user-id");
    for (const action of ["read", "write", "read_all", "manage"] as const) {
      const entry = perms.find(
        (p) => p.resource === "field_survey" && p.action === action,
      );
      expect(entry, `field_survey:${action}`).toBeDefined();
      expect(entry?.granted).toBe(true);
    }
  });
});
