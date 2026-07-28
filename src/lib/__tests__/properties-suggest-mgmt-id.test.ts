/**
 * POST /api/properties/suggest の管理ID組込テスト。
 *
 * - q で管理ID hit する（property.OR に { id: { in: [...] } } が追加される）
 * - 既存の住所/地番検索は壊れない
 * - AuditLog は qLen / resultCount のみ（検索語そのものを残さない）
 * - field_staff scope が効く
 * - rawData 全文がレスポンスに含まれない
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
    property: { findMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/properties/suggest/route";
import { MGMT_ID_SUGGEST_LIMIT } from "@/lib/property-mgmt-id-search";

const pm = prisma as unknown as {
  property: { findMany: Mock };
  importJobRow: { findMany: Mock };
};

const PERMS = [
  { resource: "property", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/properties/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-admin",
    email: "a@a",
    name: "A",
    role: "admin",
  } as any);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS);

  pm.property.findMany.mockResolvedValue([]);
  pm.importJobRow.findMany.mockResolvedValue([]);
});

function listCall() {
  // suggest 本体の property.findMany は take=10 を持つ
  return pm.property.findMany.mock.calls.find((c: any[]) => c[0]?.take === 10) as any[];
}

describe("POST /api/properties/suggest 管理ID組込", () => {
  it("q が管理ID にマッチした場合、property.OR に { id: { in: [...] } } が追加される", async () => {
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.job?.fileName?.contains === "受付帳") {
        return [{ createdId: "p1" }];
      }
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1 && ids[0] === "p1") return [{ id: "p1" }];
      return [];
    });

    const res = await POST(makeRequest({ q: "受付帳" }));
    expect(res.status).toBe(200);

    const call = listCall();
    expect(call).toBeDefined();
    const or = (call as any)[0].where.AND?.[0]?.OR ?? [];
    // 住所/地番/realEstate/buildingNumber + (ownerOr) + (mgmtOr)
    const mgmtClause = or.find((c: any) => c?.id?.in);
    expect(mgmtClause).toBeDefined();
    expect(mgmtClause.id.in).toEqual(["p1"]);
  });

  it("管理ID hit がなくても、既存の住所/地番検索 OR は残る", async () => {
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.property.findMany.mockResolvedValue([]);

    await POST(makeRequest({ q: "東京" }));
    const call = listCall();
    const or = (call as any)[0].where.AND?.[0]?.OR ?? [];
    expect(or.some((c: any) => c.address?.contains === "東京")).toBe(true);
    expect(or.some((c: any) => c.lotNumber?.contains === "東京")).toBe(true);
    // mgmt hit はないので id.in 句は含まれない
    expect(or.some((c: any) => c?.id?.in)).toBe(false);
  });

  it("AuditLog は qLen / resultCount のみ。q 値そのものを含まない", async () => {
    const Q = "受付帳特定値";
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.property.findMany.mockResolvedValue([]);

    await POST(makeRequest({ q: Q }));

    const auditCalls = vi.mocked(writeAuditLog).mock.calls;
    expect(auditCalls.length).toBeGreaterThan(0);
    const detail: any = (auditCalls.at(-1) as any)[0].detail;
    expect(detail.qLen).toBe(Q.length);
    expect(detail.resultCount).toBe(0);
    expect(detail.q).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(Q);
  });

  it("field_staff scope: AND に createdBy/assignedTo が積まれる", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "fs-1",
      email: "fs@x",
      name: "FS",
      role: "field_staff",
    } as any);
    pm.property.findMany.mockResolvedValue([]);

    await POST(makeRequest({ q: "東京" }));
    const call = listCall();
    const and = (call as any)[0].where.AND ?? [];
    const scopeClause = and.find((c: any) =>
      c?.OR?.some((x: any) => x.createdBy === "fs-1"),
    );
    expect(scopeClause).toBeDefined();
    expect(scopeClause.OR).toContainEqual({ createdBy: "fs-1" });
    expect(scopeClause.OR).toContainEqual({ assignedTo: "fs-1" });
  });

  it("非Property createdId が大量に混入しても、suggest で実在Property候補が返る", async () => {
    // helper の branch (c) fileName-only page 1: 500件 Owner.id, page 2: 1件 Property.id
    const ownerPage = Array.from({ length: 500 }, (_, i) => ({
      id: `r1-${i}`,
      createdId: `o${i}`,
    }));
    const propPage = [{ id: "r2-0", createdId: "p1" }];

    let importCallIdx = 0;
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      // helper の fileName-only branch ページング
      if (where?.job?.fileName?.contains === "受付帳" && !where?.rawData) {
        importCallIdx++;
        if (importCallIdx === 1) return ownerPage;
        if (importCallIdx === 2) return propPage;
        return [];
      }
      // suggest 側 importSource 取得
      if (where?.createdId?.in) {
        return [
          {
            createdId: "p1",
            rowNumber: 120,
            rawData: { __sourceRef: "受付帳.xlsx:120行" },
            job: { fileName: "受付帳.xlsx" },
          },
        ];
      }
      return [];
    });
    pm.property.findMany.mockImplementation(async ({ where, take }: any) => {
      if (take === 10) {
        // suggest 本体 list
        return [
          {
            id: "p1",
            address: "東京都千代田区1-1",
            dmStatus: "hold",
            propertyOwners: [],
          },
        ];
      }
      // helper の Property 実在チェック
      if (where?.id?.in) {
        const ids = where.id.in as string[];
        return ids.filter((id) => id === "p1").map((id) => ({ id }));
      }
      return [];
    });

    const res = await POST(makeRequest({ q: "受付帳" }));
    expect(res.status).toBe(200);

    const call = listCall();
    const or = (call as any)[0].where.AND?.[0]?.OR ?? [];
    const mgmtClause = or.find((c: any) => c?.id?.in);
    expect(mgmtClause).toBeDefined();
    expect(mgmtClause.id.in).toEqual(["p1"]);
  });

  it("範囲外 rowNumber (9999999999) で 500 にならず、qLen/resultCount のみ", async () => {
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.property.findMany.mockResolvedValue([]);

    const Q = "9999999999";
    const res = await POST(makeRequest({ q: Q }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);

    // 範囲外なら helper が早期 return → ImportJobRow は本体 importSource 用も含めて呼ばれない
    expect(pm.importJobRow.findMany).not.toHaveBeenCalled();

    const detail: any = (vi.mocked(writeAuditLog).mock.calls.at(-1) as any)[0].detail;
    expect(detail.qLen).toBe(Q.length);
    expect(detail.resultCount).toBe(0);
    expect(detail.q).toBeUndefined();
  });

  it("範囲外 rowNumber (受付帳.xlsx:9999999999) で 500 にならない", async () => {
    pm.importJobRow.findMany.mockResolvedValue([]);
    pm.property.findMany.mockResolvedValue([]);

    const Q = "受付帳.xlsx:9999999999";
    const res = await POST(makeRequest({ q: Q }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it("rawData 全文がレスポンスに混入しない（既存の importSource 文字列のみ）", async () => {
    pm.property.findMany.mockImplementation(async ({ where, take }: any) => {
      if (take === 10) {
        return [
          {
            id: "p1",
            address: "東京都千代田区1-1",
            dmStatus: "hold",
            propertyOwners: [],
          },
        ];
      }
      const ids: string[] = where?.id?.in ?? [];
      if (ids.length === 1 && ids[0] === "p1") return [{ id: "p1" }];
      return [];
    });
    // 本体 importSource 取得 (suggest route 側) で createdId='p1' を返す
    pm.importJobRow.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.createdId?.in) {
        return [
          {
            createdId: "p1",
            rowNumber: 120,
            rawData: {
              __sourceRef: "受付帳.xlsx:120行",
              所有者: "PII漏れ防止確認用文字列",
            },
            job: { fileName: "受付帳.xlsx" },
          },
        ];
      }
      return [];
    });

    const res = await POST(makeRequest({ q: "東京" }));
    const body = await res.json();
    const json = JSON.stringify(body);
    // importSource 文字列は出る
    expect(json).toContain("受付帳.xlsx:120行");
    // rawData 内の他のフィールドはレスポンスに含まれない
    expect(json).not.toContain("PII漏れ防止確認用文字列");
  });
});

describe("補完の管理ID解決は小さく上限を切る (@codex #330 R2)", () => {
  it("1打鍵で数千件の id を検証して巨大な IN 句を組まない", async () => {
    // 共有既定 (CSV 向け 10,000) のまま使うと、よくある取込ファイル名に一致する
    // 2 文字クエリで 1 打鍵ごとに最大 10,001 件をページングして実在チェックし、
    // その UUID 全部を IN 句に載せてしまう。候補は 10 件しか返さない。
    const many = Array.from({ length: 3000 }, (_, i) => ({
      id: `row-${i}`,
      createdId: `p${i}`,
    }));
    pm.importJobRow.findMany.mockImplementation(async ({ take }: any) =>
      many.slice(0, take ?? many.length),
    );
    pm.property.findMany.mockImplementation(async (arg: any) =>
      arg?.where?.id?.in
        ? (arg.where.id.in as string[]).map((id) => ({ id }))
        : [],
    );

    await POST(makeRequest({ q: "受付" }));

    const call = listCall();
    const or = (call as any)[0].where.AND?.[0]?.OR ?? [];
    const mgmtCond = or.find((c: any) => c?.id?.in !== undefined);
    expect(mgmtCond).toBeDefined();
    expect(mgmtCond.id.in.length).toBeLessThanOrEqual(MGMT_ID_SUGGEST_LIMIT);
  });
});
