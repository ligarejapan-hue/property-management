/**
 * GET /api/admin/owners/name-quality-candidates のルートテスト（DQ-01）。
 *
 * 検証観点:
 * - 認可（user_management:read / owner:read の 403）
 * - type フィルタ（all は info を除外 / numeric_only / mostly_digits）
 * - archived 除外（where: isArchived false）
 * - PII マスキング（name / nameKana）
 * - summary 集計
 * - blockReasons / recommendedAction
 * - AuditLog detail に氏名生値が含まれない
 * - cursor / limit ページング
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
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
    ApiError: MockApiError,
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1", role: "admin" }),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
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

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findMany: vi.fn() },
    changeLog: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions, getOwnerDisplayConfig } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { GET } from "../../app/api/admin/owners/name-quality-candidates/route";

const pm = prisma as unknown as {
  owner: { findMany: Mock };
  changeLog: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS_FULL = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const DISPLAY_FULL = {
  name: "full" as const,
  nameKana: "full" as const,
  phone: "full" as const,
  zip: "full" as const,
  address: "full" as const,
  note: "full" as const,
  email: "full" as const,
  corporateNumber: "full" as const,
};

function owner(
  over: Partial<{
    id: string;
    name: string;
    nameKana: string | null;
    note: string | null;
    corporateNumber: string | null;
    externalLinkKey: string | null;
    version: number;
    propertyOwners: number;
  }> = {},
) {
  return {
    id: over.id ?? "o-1",
    name: over.name ?? "44225",
    nameKana: over.nameKana ?? null,
    note: over.note ?? null,
    corporateNumber: over.corporateNumber ?? null,
    externalLinkKey: over.externalLinkKey ?? null,
    version: over.version ?? 1,
    _count: { propertyOwners: over.propertyOwners ?? 0 },
  };
}

function url(query = "") {
  return new Request(
    `http://localhost/api/admin/owners/name-quality-candidates${query}`,
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  vi.mocked(getOwnerDisplayConfig).mockResolvedValue(DISPLAY_FULL);
  pm.owner.findMany.mockResolvedValue([]);
  pm.changeLog.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("認可", () => {
  it("user_management:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
    ]);
    expect((await GET(url())).status).toBe(403);
  });

  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
    ]);
    expect((await GET(url())).status).toBe(403);
  });
});

describe("分類とフィルタ", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225" }), // numeric_only
      owner({ id: "o-2", name: "---" }), // symbol_only
      owner({ id: "o-3", name: "302山" }), // mostly_digits (info)
      owner({ id: "o-4", name: "山田太郎" }), // 問題なし
    ]);
  });

  it("type=all は error/warning のみ（info の mostly_digits を除外）", async () => {
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1", "o-2"]);
  });

  it("type=numeric_only で numeric のみ", async () => {
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);
    expect(json.candidates[0].ownerId).toBe("o-1");
    expect(json.candidates[0].issues).toContain("numeric_only");
  });

  it("type=mostly_digits で info も明示表示できる", async () => {
    const res = await GET(url("?type=mostly_digits"));
    const json = await res.json();
    expect(json.candidates.map((c: { ownerId: string }) => c.ownerId)).toEqual(["o-3"]);
  });

  it("summary は全 owner ベース", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(json.summary.numericOnly).toBe(1);
    expect(json.summary.symbolOnly).toBe(1);
    expect(json.summary.mostlyDigits).toBe(1);
    expect(json.summary.totalCandidates).toBe(3);
  });

  it("問題なし owner は候補に出ない", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(
      json.candidates.find((c: { ownerId: string }) => c.ownerId === "o-4"),
    ).toBeUndefined();
  });
});

describe("archived 除外", () => {
  it("findMany の where は isArchived:false", async () => {
    await GET(url());
    const arg = pm.owner.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ isArchived: false });
  });
});

describe("blockReasons / recommendedAction", () => {
  it("safeguard（紐づきあり）は hold", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225", propertyOwners: 2 }),
    ]);
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("property_owner_exists");
    expect(json.candidates[0].recommendedAction).toBe("hold");
  });

  it("制御文字のみ・safeguard なしは sanitize_candidate", async () => {
    const controlName = "山田太郎".slice(0, 2) + String.fromCharCode(1) + "太郎";
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: controlName }),
    ]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=control_chars"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("sanitize_candidate");
  });

  it("数値ゴミ・safeguard なしは review", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", name: "44225" })]);
    pm.importJobRow.findMany.mockResolvedValue([
      { createdId: "o-1", status: "success" },
    ]);
    const res = await GET(url("?type=numeric_only"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("review");
  });
});

describe("PII マスキング", () => {
  it("name は display-level に従ってマスクされる", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      name: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "山123456" }),
    ]);
    const res = await GET(url("?type=mostly_digits"));
    const json = await res.json();
    expect(json.candidates[0].ownerNameMasked).not.toBe("山123456");
  });
});

describe("AuditLog PII 漏洩防止", () => {
  it("detail に氏名生値が含まれず type/summary のみ", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", name: "44225" }),
    ]);
    await GET(url("?type=numeric_only"));
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_name_quality_candidates_list");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("44225");
    expect(call.detail).toHaveProperty("summary");
    expect(call.detail).toHaveProperty("resultCount");
  });
});

describe("ページング", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) =>
        owner({ id: `o-${i}`, name: `${1000 + i}` }),
      ),
    );
  });

  it("limit=2 で 2 件 + hasNextPage", async () => {
    const res = await GET(url("?type=numeric_only&limit=2"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(json.candidates[1].ownerId);
  });

  it("cursor で続きを取得", async () => {
    const res1 = await GET(url("?type=numeric_only&limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(url(`?type=numeric_only&limit=2&cursor=${json1.nextCursor}`));
    const json2 = await res2.json();
    expect(json2.candidates[0].ownerId > json1.nextCursor).toBe(true);
  });
});
