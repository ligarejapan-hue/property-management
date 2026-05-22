/**
 * NEXT_PUBLIC_USE_MOCK=true 時の mock permission payload に
 * owner_corporate_number が含まれることを確認する。
 *
 * 背景: seed/migration で owner_corporate_number field-level permission を追加したため、
 * mock セッションで法人番号付き Owner create/update を行うと、
 * 対応する mock permission がないと 403 になる。
 *
 * - mock permission payload に owner_corporate_number:full/granted が含まれる
 * - 既存 owner_name / owner_address / owner_email 等が壊れていない
 * - mock セッション相当の権限で corporateNumber 付き Owner create が 403 にならない
 * - mock セッション相当の権限で corporateNumber 付き Owner update が 403 にならない
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── source assertion ────────────────────────────────────────────────────────

const apiHelpersSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/lib/api-helpers.ts"),
  "utf8",
);

describe("api-helpers.ts — mock permission payload", () => {
  it("NEXT_PUBLIC_USE_MOCK 用 mock permission 配列に owner_corporate_number:full がある", () => {
    // mock 分岐内の配列全体（[...]）を抽出し、その中に owner_corporate_number があることを確認。
    const mockBlock = apiHelpersSrc.match(
      /NEXT_PUBLIC_USE_MOCK[\s\S]*?return\s*\[[\s\S]*?\];/,
    );
    expect(mockBlock).not.toBeNull();
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"owner_corporate_number",\s*action:\s*"full",\s*granted:\s*true/,
    );
  });

  it("既存の owner_name / owner_address / owner_email mock 権限が壊れていない", () => {
    const mockBlock = apiHelpersSrc.match(
      /NEXT_PUBLIC_USE_MOCK[\s\S]*?return\s*\[[\s\S]*?\];/,
    );
    expect(mockBlock).not.toBeNull();
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"owner_name",\s*action:\s*"full",\s*granted:\s*true/,
    );
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"owner_address",\s*action:\s*"full",\s*granted:\s*true/,
    );
    expect(mockBlock?.[0]).toMatch(
      /resource:\s*"owner_email",\s*action:\s*"full",\s*granted:\s*true/,
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

describe("getUserPermissions — NEXT_PUBLIC_USE_MOCK=true", () => {
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

  it("mock permissions に owner_corporate_number:full/granted=true が含まれる", async () => {
    const perms = await getUserPermissions("any-user-id");
    const entry = perms.find(
      (p) => p.resource === "owner_corporate_number" && p.action === "full",
    );
    expect(entry).toBeDefined();
    expect(entry?.granted).toBe(true);
  });

  it("mock permissions に owner:write / owner:read が含まれる（既存）", async () => {
    const perms = await getUserPermissions("any-user-id");
    expect(
      perms.find((p) => p.resource === "owner" && p.action === "write")?.granted,
    ).toBe(true);
    expect(
      perms.find((p) => p.resource === "owner" && p.action === "read")?.granted,
    ).toBe(true);
  });

  it("mock permissions に owner_name / owner_address / owner_email:full が含まれる（既存）", async () => {
    const perms = await getUserPermissions("any-user-id");
    expect(
      perms.find((p) => p.resource === "owner_name" && p.action === "full")
        ?.granted,
    ).toBe(true);
    expect(
      perms.find((p) => p.resource === "owner_address" && p.action === "full")
        ?.granted,
    ).toBe(true);
    expect(
      perms.find((p) => p.resource === "owner_email" && p.action === "full")
        ?.granted,
    ).toBe(true);
  });
});

// ── integration: mock perms → POST /api/owners / PATCH /api/owners/[id] ────
//
// mock 時の getUserPermissions の戻り値をそのまま route に渡し、403 にならないことを確認する。
// 他の corporate-number-route.test.ts と同様に next/server, api-helpers, prisma を mock する。

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", async () => {
  // 実 getUserPermissions を呼び出し、その mock 分岐の出力を route に渡す。
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>(
    "@/lib/api-helpers",
  );

  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  return {
    ...actual,
    ApiError: MockApiError,
    getApiSession: vi.fn().mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000001",
      email: "admin@example.com",
      name: "モック管理者",
      role: "admin",
    }),
    // 本物の mock 分岐の戻り値をそのまま使う
    getUserPermissions: vi.fn(async () => {
      process.env.NEXT_PUBLIC_USE_MOCK = "true";
      return actual.getUserPermissions("00000000-0000-0000-0000-000000000001");
    }),
    getOwnerDisplayConfig: vi.fn().mockResolvedValue({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "full",
    }),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      if (error && typeof error === "object" && "issues" in error) {
        return Response.json(
          { error: { message: "validation error", code: "VALIDATION_ERROR" } },
          { status: 422 },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/change-log")>();
  return { ...actual, recordChanges: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    permissionTemplate: { findUnique: vi.fn() },
    userPermission: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { POST as OWNERS_POST } from "../../app/api/owners/route";
import { PATCH as OWNERS_PATCH } from "../../app/api/owners/[id]/route";

const pm = prisma as unknown as {
  owner: {
    findUnique: Mock;
    findUniqueOrThrow: Mock;
    updateMany: Mock;
    findMany: Mock;
    create: Mock;
  };
};

const MOCK_OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000099";

describe("Mock permissions → corporateNumber create/update は 403 にならない", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_USE_MOCK = "true";

    // POST 用
    pm.owner.findMany.mockResolvedValue([]);
    pm.owner.create.mockImplementation(async ({ data }: any) => ({
      id: "mock-new-owner",
      ...data,
      version: 1,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // PATCH 用
    pm.owner.findUnique.mockResolvedValue({
      id: MOCK_OWNER_ID,
      name: "株式会社モック",
      nameKana: null,
      phone: null,
      zip: null,
      address: null,
      note: null,
      email: null,
      corporateNumber: null,
      version: 1,
      isArchived: false,
    });
    pm.owner.updateMany.mockResolvedValue({ count: 1 });
    pm.owner.findUniqueOrThrow.mockResolvedValue({
      id: MOCK_OWNER_ID,
      name: "株式会社モック",
      version: 2,
      corporateNumber: "1234567890123",
      propertyOwners: [],
      isArchived: false,
    });
  });

  it("mock セッションで corporateNumber 付き Owner create が 201 を返す（403 にならない）", async () => {
    const req = new Request("http://localhost/api/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "株式会社モック",
        corporateNumber: "1234567890123",
      }),
    }) as unknown as import("next/server").NextRequest;

    const res = await OWNERS_POST(req);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
    expect(pm.owner.create).toHaveBeenCalled();
    const data = pm.owner.create.mock.calls[0][0].data;
    expect(data.corporateNumber).toBe("1234567890123");
  });

  it("mock セッションで corporateNumber update が 200 を返す（403 にならない）", async () => {
    const req = new Request(`http://localhost/api/owners/${MOCK_OWNER_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, corporateNumber: "1234567890123" }),
    }) as unknown as import("next/server").NextRequest;

    const res = await OWNERS_PATCH(req, {
      params: Promise.resolve({ id: MOCK_OWNER_ID }),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(pm.owner.updateMany).toHaveBeenCalled();
    const updateCall = pm.owner.updateMany.mock.calls[0][0];
    expect(updateCall.data.corporateNumber).toBe("1234567890123");
  });
});
