/**
 * GET /api/properties/quality-check（性能改善: 上限付きスキャン + _count）の統合テスト。
 *
 * 確認項目（番号は指示の 1〜10 に対応）:
 *  1. take: QUALITY_CHECK_SCAN_LIMIT + 1 相当の上限付き findMany を行う
 *  2. propertyOwners の id 配列ではなく _count.propertyOwners を使う（所有者PII列を取得しない）
 *  3. _count.propertyOwners === 0 の物件が NO_OWNER 警告対象になる
 *  4. 所有者ありの物件は NO_OWNER 警告対象にならない
 *  5. 上限超過時に summary.scanLimited が true（エラーにはしない）
 *  6. 上限未満では summary.scanLimited が false
 *  7. where.isArchived === false が維持される
 *  8. 権限（property:read）欠如で 403・findMany 未実行（既存挙動）
 *  9. レスポンスに所有者名・住所・郵便番号などの所有者PIIが入らない
 * 10. route.ts は GET ハンドラ以外を export しない
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
    // apiResponse / handleApiError は実シリアライズに近い形で Response を返す。
    apiResponse: vi.fn((payload: unknown) =>
      Response.json(payload as Record<string, unknown>, { status: 200 }),
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
const PERMS_NO_PROPERTY = [
  { resource: "owner", action: "read", granted: true },
];

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
    // SCAN_LIMIT(5000) + 1 のセンチネル方式
    expect(args.take).toBe(5001);
  });

  it("02. propertyOwners は _count を使い、id 配列(所有者PII列)を取得しない", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET();
    const args = pm.property.findMany.mock.calls[0][0];
    expect(args.select._count).toEqual({ select: { propertyOwners: true } });
    // 旧実装の propertyOwners: { select: { id: true } } は使わない
    expect(args.select.propertyOwners).toBeUndefined();
    // 所有者の PII 列を一切 select しない
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

  it("05. 上限超過時は scanLimited=true（エラーにせず先頭 scanLimit 件で判定）", async () => {
    // take(=limit+1) 件返す → 上限超過。limit を直接ハードコードせず take から生成。
    pm.property.findMany.mockImplementation(async (args: { take: number }) =>
      Array.from({ length: args.take }, (_, i) => makeProp({ id: `p${i}` })),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.scanLimited).toBe(true);
    // 判定対象は先頭 scanLimit 件（= take - 1）に丸められる
    expect(body.summary.propertiesChecked).toBe(body.summary.scanLimit);
    expect(body.summary.propertiesChecked).toBe(5000);
  });

  it("06. 上限未満では scanLimited=false", async () => {
    pm.property.findMany.mockImplementation(async (args: { take: number }) =>
      // ちょうど上限(= take - 1)件 → 超過ではない
      Array.from({ length: args.take - 1 }, (_, i) => makeProp({ id: `p${i}` })),
    );
    const res = await GET();
    const body = await res.json();
    expect(body.summary.scanLimited).toBe(false);
    expect(body.summary.propertiesChecked).toBe(5000);
  });

  it("06b. 少数件でも scanLimited=false かつ propertiesChecked が実件数", async () => {
    pm.property.findMany.mockResolvedValue([makeProp(), makeProp({ id: "p2" })]);
    const res = await GET();
    const body = await res.json();
    expect(body.summary.scanLimited).toBe(false);
    expect(body.summary.propertiesChecked).toBe(2);
  });

  it("07. where.isArchived === false が維持される", async () => {
    pm.property.findMany.mockResolvedValue([makeProp()]);
    await GET();
    const args = pm.property.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ isArchived: false });
  });

  it("08. property:read 欠如で 403・findMany 未実行", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("09. レスポンスに所有者PII（氏名・所有者住所・郵便番号等）が入らない", async () => {
    pm.property.findMany.mockResolvedValue([
      makeProp({ id: "p1", _count: { propertyOwners: 0 } }),
    ]);
    const res = await GET();
    const body = await res.json();
    // issue は固定キーのみ（所有者由来のキーは無い）
    for (const issue of body.data) {
      expect(Object.keys(issue).sort()).toEqual(
        ["address", "code", "message", "propertyId", "severity"].sort(),
      );
    }
    // summary も非PIIキーのみ
    expect(Object.keys(body.summary).sort()).toEqual(
      [
        "errors",
        "info",
        "propertiesChecked",
        "scanLimit",
        "scanLimited",
        "total",
        "warnings",
      ].sort(),
    );
    // 念のため文字列レベルでも所有者PIIの痕跡が無い
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("ownerName");
    expect(bodyStr).not.toContain("nameKana");
    expect(bodyStr).not.toContain("propertyOwners");
  });

  it("10. route.ts は GET 以外を export しない", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["GET"]);
  });
});
