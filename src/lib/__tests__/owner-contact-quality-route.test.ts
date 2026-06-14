/**
 * GET /api/admin/owners/contact-quality-candidates のルートテスト（DQ-02）。
 *
 * 観点: 認可 / type フィルタ(all は warning のみ) / archived 除外 / PII マスキング /
 * summary / blockReasons / recommendedAction / AuditLog 非PII / ページング。
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
import { GET } from "../../app/api/admin/owners/contact-quality-candidates/route";

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
    zip: string | null;
    phone: string | null;
    note: string | null;
    externalLinkKey: string | null;
    version: number;
    propertyOwners: number;
  }> = {},
) {
  return {
    id: over.id ?? "o-1",
    zip: over.zip ?? null,
    phone: over.phone ?? null,
    note: over.note ?? null,
    externalLinkKey: over.externalLinkKey ?? null,
    version: over.version ?? 1,
    _count: { propertyOwners: over.propertyOwners ?? 0 },
  };
}

function url(query = "") {
  return new Request(
    `http://localhost/api/admin/owners/contact-quality-candidates${query}`,
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
      owner({ id: "o-1", zip: "123" }), // zip_suspicious (warning)
      owner({ id: "o-2", phone: "不明" }), // phone_non_phone (warning)
      owner({ id: "o-3", zip: "1234567" }), // zip_unformatted (info)
      owner({ id: "o-4", zip: "123-4567", phone: "090-1234-5678" }), // clean
    ]);
  });

  it("type=all は warning のみ（info の unformatted を除外）", async () => {
    const res = await GET(url());
    const json = await res.json();
    const ids = json.candidates.map((c: { ownerId: string }) => c.ownerId).sort();
    expect(ids).toEqual(["o-1", "o-2"]);
  });

  it("type=zip_unformatted で info を明示表示", async () => {
    const res = await GET(url("?type=zip_unformatted"));
    const json = await res.json();
    expect(json.candidates.map((c: { ownerId: string }) => c.ownerId)).toEqual(["o-3"]);
  });

  it("summary は全 owner ベース", async () => {
    const res = await GET(url());
    const json = await res.json();
    expect(json.summary.zipSuspicious).toBe(1);
    expect(json.summary.phoneNonPhone).toBe(1);
    expect(json.summary.zipUnformatted).toBe(1);
    expect(json.summary.totalCandidates).toBe(3);
  });

  it("clean owner は候補に出ない", async () => {
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
    expect(pm.owner.findMany.mock.calls[0][0].where).toEqual({ isArchived: false });
  });
});

describe("blockReasons / recommendedAction", () => {
  it("safeguard（紐づきあり）は hold", async () => {
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "123", propertyOwners: 2 }),
    ]);
    const res = await GET(url("?type=zip_suspicious"));
    const json = await res.json();
    expect(json.candidates[0].blockReasons).toContain("property_owner_exists");
    expect(json.candidates[0].recommendedAction).toBe("hold");
  });

  it("未整形のみ・safeguard なしは format_candidate", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", zip: "1234567" })]);
    pm.importJobRow.findMany.mockResolvedValue([{ createdId: "o-1", status: "success" }]);
    const res = await GET(url("?type=zip_unformatted"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("format_candidate");
  });

  it("suspicious・safeguard なしは review", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", zip: "123" })]);
    pm.importJobRow.findMany.mockResolvedValue([{ createdId: "o-1", status: "success" }]);
    const res = await GET(url("?type=zip_suspicious"));
    const json = await res.json();
    expect(json.candidates[0].recommendedAction).toBe("review");
  });
});

describe("PII マスキング", () => {
  it("zip/phone は display-level に従ってマスク", async () => {
    vi.mocked(getOwnerDisplayConfig).mockResolvedValueOnce({
      ...DISPLAY_FULL,
      zip: "masked",
      phone: "masked",
    });
    pm.owner.findMany.mockResolvedValue([
      owner({ id: "o-1", zip: "1234567", phone: "不明" }),
    ]);
    const res = await GET(url("?type=phone_non_phone"));
    const json = await res.json();
    expect(json.candidates[0].phoneMasked).not.toBe("不明");
  });
});

describe("AuditLog 非PII", () => {
  it("detail に zip/phone 生値が含まれず type/summary のみ", async () => {
    pm.owner.findMany.mockResolvedValue([owner({ id: "o-1", phone: "09098761234" })]);
    await GET(url());
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_contact_quality_candidates_list");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("09098761234");
    expect(call.detail).toHaveProperty("summary");
  });
});

describe("ページング", () => {
  beforeEach(() => {
    pm.owner.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) =>
        owner({ id: `o-${i}`, zip: "123" }),
      ),
    );
  });
  it("limit=2 で 2 件 + hasNextPage", async () => {
    const res = await GET(url("?type=zip_suspicious&limit=2"));
    const json = await res.json();
    expect(json.candidates).toHaveLength(2);
    expect(json.hasNextPage).toBe(true);
    expect(json.nextCursor).toBe(json.candidates[1].ownerId);
  });
  it("cursor で続き", async () => {
    const res1 = await GET(url("?type=zip_suspicious&limit=2"));
    const json1 = await res1.json();
    const res2 = await GET(url(`?type=zip_suspicious&limit=2&cursor=${json1.nextCursor}`));
    const json2 = await res2.json();
    expect(json2.candidates[0].ownerId > json1.nextCursor).toBe(true);
  });
});
