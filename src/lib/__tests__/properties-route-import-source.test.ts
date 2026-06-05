/**
 * GET /api/properties（一覧）が importSource を返さない／逆引きしないことの検証（17-C F1）。
 *
 * 一覧 UI は importSource を描画していないにもかかわらず、従来は一覧 GET ごとに
 * loadImportSourceMap（ImportJobRow.findMany / rawData JSONB select 込み）が
 * 常時実行されていた。本テストはその除去を仕様としてロックする:
 * - 一覧結果が非空でも importJobRow.findMany（importSource 逆引き）を呼ばない
 * - レスポンスの各要素に importSource キーを含まない
 * - ownerNames 等の既存マッピング・pagination 形状は不変
 *
 * importSource が必要な経路（詳細 GET / CSV export / dm-export / suggest）は
 * それぞれ自前で取得しており本変更の対象外（各 route のテストで担保）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    nextUrl: URL;
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
      this.nextUrl = new URL(typeof input === "string" ? input : (input as Request).url);
    }
  }
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
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn().mockResolvedValue({
      name: "full",
      address: "full",
      phone: "full",
      zip: "full",
    }),
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
    property: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    importJobRow: {
      findMany: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS_FULL = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

function makeRequest(qs: string) {
  return new Request(`http://localhost/api/properties${qs}`, { method: "GET" }) as unknown as import("next/server").NextRequest;
}

function makeListRow(id: string) {
  return {
    id,
    propertyType: "land",
    address: `東京都千代田区1-1 (${id})`,
    lotNumber: null,
    buildingNumber: null,
    realEstateNumber: null,
    registryStatus: "unconfirmed",
    dmStatus: "hold",
    caseStatus: "new_case",
    introductionRoute: null,
    isArchived: false,
    updatedAt: new Date(),
    assignedTo: null,
    gpsLat: null,
    gpsLng: null,
    investigationConfirmedAt: null,
    assignee: null,
    propertyOwners: [{ owner: { name: "田中太郎" } }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    email: "a@a",
    name: "A",
    role: "admin",
  } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);

  pm.property.findMany.mockResolvedValue([makeListRow("p1"), makeListRow("p2")]);
  pm.property.count.mockResolvedValue(2);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

describe("GET /api/properties — importSource 非付与（17-C F1）", () => {
  it("一覧結果が非空でも importJobRow.findMany（importSource 逆引き）を呼ばない", async () => {
    const res = await GET(makeRequest(""));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);

    // 従来は properties が非空だと loadImportSourceMap が
    // importJobRow.findMany({ createdId: { in: [...] }, status: "success" })
    // を発行していた。除去後は一切呼ばれない。
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();
  });

  it("レスポンスの各要素に importSource キーを含まない", async () => {
    const res = await GET(makeRequest(""));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item).not.toHaveProperty("importSource");
    }
  });

  it("ownerNames マッピングと propertyOwners 除去は従来どおり（非退行）", async () => {
    const res = await GET(makeRequest(""));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data[0].ownerNames).toEqual(["田中太郎"]);
    expect(body.data[0]).not.toHaveProperty("propertyOwners");
    expect(body.data[0].address).toContain("東京都千代田区1-1");
  });

  it("pagination 形状は不変（page/limit/total/totalPages）", async () => {
    const res = await GET(makeRequest("?page=1&limit=50"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pagination).toEqual({
      page: 1,
      limit: 50,
      total: 2,
      totalPages: 1,
    });
  });
});
