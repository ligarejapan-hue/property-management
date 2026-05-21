/**
 * GET /api/properties の mgmtId 統合テスト。
 *
 * - mgmtId 単独で一覧検索できる
 * - keyword 単独の既存検索が壊れない
 * - keyword + mgmtId は AND になる
 * - mgmtId 該当0件 → 空結果（property.findMany は呼ばれない）
 * - field_staff scope は維持
 * - archived は除外 (where.isArchived=false)
 * - AuditLog に mgmtId 値そのものを含まない / mgmtIdLen, mgmtHitCount は含む
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
import { writeAuditLog } from "@/lib/audit";
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    email: "a@a",
    name: "A",
    role: "admin",
  } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);

  // Default: property.findMany / count return empty
  pm.property.findMany.mockResolvedValue([]);
  pm.property.count.mockResolvedValue(0);
  // importJobRow.findMany default empty; tests override
  pm.importJobRow.findMany.mockResolvedValue([]);
});

function lastWriteAuditLogCall(): any {
  const mock = vi.mocked(writeAuditLog);
  return mock.mock.calls.at(-1)?.[0];
}

describe("GET /api/properties mgmtId 統合", () => {
  it("mgmtId 単独 → helper hit 後 where.AND に { id: { in: [...] } } が入る", async () => {
    // helper の呼び出し: ImportJobRow.findMany を 2回 (fileName+rowNumber, fallback) + property.findMany (existence)
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.rowNumber === 120 && where?.job) {
        return [{ createdId: "p1" }];
      }
      // fallback (__sourceRef)
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where }: any) => {
      // helper の property 存在確認
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1 && ids[0] === "p1") {
        return [{ id: "p1" }];
      }
      // 本体 query (list)
      return [
        {
          id: "p1",
          propertyType: "land",
          address: "東京都千代田区1-1",
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
          propertyOwners: [],
        },
      ];
    });
    pm.property.count.mockResolvedValue(1);

    const res = await GET(makeRequest("?mgmtId=" + encodeURIComponent("受付帳.xlsx:120行")));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("p1");

    // property.findMany 本体 query の where に id.in が含まれる
    const listCall = pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take !== undefined);
    expect(listCall).toBeDefined();
    const whereAnd = (listCall as any)[0].where.AND ?? [];
    const idInClause = whereAnd.find((c: any) => c?.id?.in);
    expect(idInClause).toBeDefined();
    expect(idInClause.id.in).toEqual(["p1"]);
    // archived 除外
    expect((listCall as any)[0].where.isArchived).toBe(false);
  });

  it("mgmtId 該当 0 件 → 空結果（list query は呼ばれない）", async () => {
    pm.importJobRow.findMany.mockResolvedValue([]); // helper 候補 0
    pm.property.findMany.mockResolvedValue([]); // helper の property 存在チェックも 0

    const res = await GET(makeRequest("?mgmtId=" + encodeURIComponent("存在しない")));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);

    // 本体 list query は呼ばれていない（property.findMany 呼び出しは helper の存在確認のみ）
    const listCall = pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take !== undefined);
    expect(listCall).toBeUndefined();
    expect(pm.property.count).not.toHaveBeenCalled();
  });

  it("keyword 単独 → mgmtId 関連の helper 呼び出しなし、既存 where.OR(keyword) が維持", async () => {
    pm.property.findMany.mockResolvedValue([]);
    pm.property.count.mockResolvedValue(0);

    const res = await GET(makeRequest("?keyword=" + encodeURIComponent("東京")));
    expect(res.status).toBe(200);

    // mgmtId helper は呼ばれていない → importJobRow.findMany は本体の importSource 取得のみ
    // (空結果なので importSource lookup もスキップ)
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();

    const listCall = pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take !== undefined);
    const whereOr = (listCall as any)[0].where.OR ?? [];
    expect(whereOr.some((c: any) => c.address?.contains === "東京")).toBe(true);
  });

  it("keyword + mgmtId は AND になる（keyword は OR で、mgmtId は AND の id.in）", async () => {
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.rowNumber === 120 && where?.job) {
        return [{ createdId: "p1" }];
      }
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1 && ids[0] === "p1") return [{ id: "p1" }];
      return [];
    });
    pm.property.count.mockResolvedValue(0);

    await GET(makeRequest("?keyword=" + encodeURIComponent("東京") + "&mgmtId=" + encodeURIComponent("受付帳.xlsx:120行")));

    const listCall = pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take !== undefined);
    const where = (listCall as any)[0].where;
    // keyword は OR
    expect(where.OR?.some((c: any) => c.address?.contains === "東京")).toBe(true);
    // mgmtId は AND の id.in
    const andClause = (where.AND ?? []).find((c: any) => c?.id?.in);
    expect(andClause?.id?.in).toEqual(["p1"]);
  });

  it("field_staff scope: AND に createdBy/assignedTo が積まれる", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "fs-1",
      email: "fs@x",
      name: "FS",
      role: "field_staff",
    } as any);

    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.rowNumber === 120) return [{ createdId: "p1" }];
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1) return [{ id: "p1" }];
      return [];
    });
    pm.property.count.mockResolvedValue(0);

    await GET(makeRequest("?mgmtId=" + encodeURIComponent("受付帳.xlsx:120行")));

    const listCall = pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take !== undefined);
    const and = (listCall as any)[0].where.AND ?? [];
    const scopeClause = and.find((c: any) => c?.OR?.some((x: any) => x.createdBy === "fs-1"));
    expect(scopeClause).toBeDefined();
    expect(scopeClause.OR).toContainEqual({ createdBy: "fs-1" });
    expect(scopeClause.OR).toContainEqual({ assignedTo: "fs-1" });
  });

  it("AuditLog: mgmtId 値そのものを含まず、mgmtIdLen と mgmtHitCount を含む", async () => {
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.rowNumber === 120) return [{ createdId: "p1" }];
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1) return [{ id: "p1" }];
      return [];
    });
    pm.property.count.mockResolvedValue(0);

    const rawMgmtId = "受付帳.xlsx:120行";
    await GET(makeRequest("?mgmtId=" + encodeURIComponent(rawMgmtId)));

    const call = lastWriteAuditLogCall();
    expect(call.action).toBe("property_list");
    expect(call.detail.mgmtIdLen).toBe(rawMgmtId.length);
    expect(call.detail.mgmtHitCount).toBe(1);
    // filters に mgmtId 生値が出ない
    expect(call.detail.filters?.mgmtId).toBeUndefined();
    // detail を JSON 化しても rawMgmtId が含まれない
    expect(JSON.stringify(call.detail)).not.toContain(rawMgmtId);
  });

  it("AuditLog: mgmtId 0 件のときも mgmtHitCount=0 / 値含まず", async () => {
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.property.findMany.mockResolvedValue([]);
    pm.property.count.mockResolvedValue(0);

    const rawMgmtId = "存在しない";
    await GET(makeRequest("?mgmtId=" + encodeURIComponent(rawMgmtId)));

    const call = lastWriteAuditLogCall();
    expect(call.detail.mgmtIdLen).toBe(rawMgmtId.length);
    expect(call.detail.mgmtHitCount).toBe(0);
    expect(call.detail.filters?.mgmtId).toBeUndefined();
    expect(JSON.stringify(call.detail)).not.toContain(rawMgmtId);
  });

  it("isArchived=false が where に必ず入る（mgmtId hit 時も）", async () => {
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.rowNumber === 120) return [{ createdId: "p1" }];
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1) return [{ id: "p1" }];
      return [];
    });
    pm.property.count.mockResolvedValue(0);

    await GET(makeRequest("?mgmtId=" + encodeURIComponent("受付帳.xlsx:120行")));

    const listCall = pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take !== undefined);
    expect((listCall as any)[0].where.isArchived).toBe(false);
  });
});
