/**
 * GET /api/properties/quality-check の統合テスト。
 * 性能改善（上限付きスキャン + _count）＋ Codex P2 対応（上限超過は 200 ではなく 409）。
 *
 * 確認項目:
 *  1. take: QUALITY_CHECK_SCAN_LIMIT + 1 相当の上限付き findMany を行う
 *  2. propertyOwners の id 配列ではなく _count.propertyOwners を使う（所有者PII列を取得しない）
 *  3. _count.propertyOwners === 0 の物件が NO_OWNER 警告対象になる
 *  4. 所有者ありの物件は NO_OWNER 警告対象にならない
 *  5. 上限超過時は 200 ではなく 409 を返す（不完全な結果を成功扱いしない）
 *  6. 上限超過時の code は QUALITY_CHECK_SCAN_LIMIT_EXCEEDED
 *  7. 上限超過時は issues（品質チェック結果）を返さない（error のみ・data/summary なし）
 *  8. 上限未満では従来どおり 200 で warnings/errors/info を返す
 *  9. where.isArchived === false が維持される
 * 10. property:read 欠如で 403・findMany 未実行（DB取得前ゲート）
 * 11. レスポンスに所有者PII（氏名・所有者住所・郵便番号等）が入らない
 * 12. route.ts は GET ハンドラ以外を export しない
 *
 * permissions（hasPermission）は実物を使用し、api-helpers / prisma のみ mock する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    // 実 api-helpers と同じく apiResponse(data, status=200) / handleApiError(error)。
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as Record<string, unknown>, { status }),
    ),
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
  };
});

vi.mock("@/lib/prisma", () => ({
  default: { property: { findMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import * as routeModule from "../../app/api/properties/quality-check/route";

const { GET } = routeModule;

const pm = prisma as unknown as { property: { findMany: Mock } };

const PERMS_FULL = [{ resource: "property", action: "read", granted: true }];
const PERMS_NO_PROPERTY = [{ resource: "owner", action: "read", granted: true }];

// route の select に対応した非PIIの最小行。所有者は _count のみ。
function makeProp(over: Record<string, unknown> = {}) {
  const { _count, ...rest } = over as { _count?: { propertyOwners: number } };
  return {
    id: "p1",
    address: "東京都千代田区1-1",
    lotNumber: "1番1",
    realEstateNumber: "1234567890123",
    registryStatus: "obtained",
    dmStatus: "hold",
    caseStatus: "new_case",
    assignedTo: "user-1",
    investigationConfirmedAt: new Date("2026-01-01T00:00:00Z"),
    _count: { propertyOwners: _count?.propertyOwners ?? 1 },
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as never);
  pm.property.findMany.mockResolvedValue([]);
});

describe("GET /api/properties/quality-check", () => {
  it("01. take: QUALITY_CHECK_SCAN_LIMIT + 1 の上限付き findMany を行う", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET();
    const args = pm.property.findMany.mock.calls[0][0];
    expect(typeof args.take).toBe("number");
    // SCAN_LIMIT(5000) + 1 のセンチネル方式（+1 で超過検出）
    expect(args.take).toBe(5001);
  });

  it("02. propertyOwners は _count を使い、id 配列(所有者PII列)を取得しない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET();
    const args = pm.property.findMany.mock.calls[0][0];
    expect(args.select._count).toEqual({ select: { propertyOwners: true } });
    expect(args.select.propertyOwners).toBeUndefined();
    const selectStr = JSON.stringify(args.select);
    expect(selectStr).not.toContain("name");
    expect(selectStr).not.toContain("zip");
    expect(selectStr).not.toContain("phone");
    expect(selectStr).not.toContain("email");
    expect(selectStr).not.toContain("nameKana");
  });

  it("03. _count.propertyOwners === 0 の物件が NO_OWNER 警告対象になる", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p-noowner", _count: { propertyOwners: 0 } }),
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const noOwner = body.data.filter(
      (i: { code: string; propertyId: string }) => i.code === "NO_OWNER",
    );
    expect(noOwner).toHaveLength(1);
    expect(noOwner[0].propertyId).toBe("p-noowner");
  });

  it("04. 所有者ありの物件は NO_OWNER 警告対象にならない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p-hasowner", _count: { propertyOwners: 2 } }),
    ]);
    const res = await GET();
    const body = await res.json();
    const noOwner = body.data.filter(
      (i: { code: string }) => i.code === "NO_OWNER",
    );
    expect(noOwner).toHaveLength(0);
  });

  it("05. 上限超過時は 200 ではなく 409 を返す（不完全な結果を成功扱いしない）", async () => {
    // take(=limit+1) 件返す → 超過。limit を直接ハードコードせず take から生成。
    pm.property.findMany.mockImplementation(async (args: { take: number }) =>
      Array.from({ length: args.take }, (_, i) =>
        makeProp({ id: `p${i}`, _count: { propertyOwners: 0 } }),
      ),
    );
    const res = await GET();
    expect(res.status).toBe(409);
  });

  it("06. 上限超過時の code は QUALITY_CHECK_SCAN_LIMIT_EXCEEDED", async () => {
    pm.property.findMany.mockImplementation(async (args: { take: number }) =>
      Array.from({ length: args.take }, (_, i) => makeProp({ id: `p${i}` })),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.error.code).toBe("QUALITY_CHECK_SCAN_LIMIT_EXCEEDED");
    expect(typeof body.error.message).toBe("string");
  });

  it("07. 上限超過時は issues（品質チェック結果）を成功として返さない", async () => {
    pm.property.findMany.mockImplementation(async (args: { take: number }) =>
      // 全件 NO_OWNER でも、超過時は「問題なし/結果あり」として返してはいけない
      Array.from({ length: args.take }, (_, i) =>
        makeProp({ id: `p${i}`, _count: { propertyOwners: 0 } }),
      ),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.data).toBeUndefined();
    expect(body.summary).toBeUndefined();
    expect(body.error).toBeDefined();
  });

  it("08. 上限未満では従来どおり 200 で warnings/errors/info を返す", async () => {
    pm.property.findMany.mockImplementation(async (args: { take: number }) =>
      // ちょうど上限(= take - 1)件 → 超過ではない → 200
      Array.from({ length: args.take - 1 }, (_, i) =>
        makeProp({ id: `p${i}`, _count: { propertyOwners: 0 } }),
      ),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.propertiesChecked).toBe(5000);
    // 5000件すべて NO_OWNER → warnings に計上
    expect(body.summary.warnings).toBeGreaterThanOrEqual(5000);
    // 後方互換: summary は従来キーのみ（scanLimited/scanLimit は持たない）
    expect(Object.keys(body.summary).sort()).toEqual(
      ["errors", "info", "propertiesChecked", "total", "warnings"].sort(),
    );
  });

  it("08b. 少数件では 200 かつ propertiesChecked が実件数", async () => {
    pm.property.findMany.mockResolvedValue([makeProp(), makeProp({ id: "p2" })]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.propertiesChecked).toBe(2);
  });

  it("09. where.isArchived === false が維持される", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET();
    const args = pm.property.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ isArchived: false });
  });

  it("10. property:read 欠如で 403・findMany 未実行（DB取得前ゲート）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("11. レスポンスに所有者PII（氏名・所有者住所・郵便番号等）が入らない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", _count: { propertyOwners: 0 } }),
    ]);
    const res = await GET();
    const body = await res.json();
    for (const issue of body.data) {
      expect(Object.keys(issue).sort()).toEqual(
        ["address", "code", "message", "propertyId", "severity"].sort(),
      );
    }
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("ownerName");
    expect(bodyStr).not.toContain("nameKana");
    expect(bodyStr).not.toContain("propertyOwners");
  });

  it("12. route.ts は GET 以外を export しない", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["GET"]);
  });
});
