/**
 * POST /api/admin/owners/correction/mislink-preview route tests.
 *
 * - dryRun のみ。DB 更新なし。
 * - 権限: user_management:read + owner:read + property:read + property record-scope
 * - PII フリー（owner名 / 住所 / 電話 / email / memo本文 / 物件住所を返さない）
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
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
    owner: { findUnique: vi.fn() },
    property: { findUnique: vi.fn() },
    propertyOwner: { findUnique: vi.fn() },
    ownerMemo: { count: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/correction/mislink-preview/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_OWNER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_OWNER_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_NAME = "誤紐づき太郎";
const PROPERTY_ADDRESS = "東京都港区テスト1-1";

const FULL_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "property", action: "read", granted: true },
];

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  property: { findUnique: Mock };
  propertyOwner: { findUnique: Mock };
  ownerMemo: { count: Mock };
};

function makeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/admin/owners/correction/mislink-preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

function setupValidState(opts: {
  currentArchived?: boolean;
  targetArchived?: boolean;
  targetExists?: boolean;
  poExists?: boolean;
  poPropertyMatch?: boolean;
  poOwnerMatch?: boolean;
  memoCount?: number;
  targetLinked?: boolean;
  propertyCreatedBy?: string;
  propertyAssignedTo?: string | null;
  propertyArchived?: boolean;
  propertyVersion?: number;
} = {}) {
  // 注: route は propertyOwner.findUnique({ include: property }) で
  //     scope 判定するため、PropertyOwner mock に property フィールドを含める。
  const actualPropertyId =
    opts.poPropertyMatch === false ? "different-prop" : PROPERTY_ID;
  pm.propertyOwner.findUnique.mockImplementation(
    ({ where }: { where: { id?: string; propertyId_ownerId?: { propertyId: string; ownerId: string } } }) => {
      if (where.id === PROPERTY_OWNER_ID) {
        if (opts.poExists === false) return Promise.resolve(null);
        return Promise.resolve({
          id: PROPERTY_OWNER_ID,
          propertyId: actualPropertyId,
          ownerId: opts.poOwnerMatch === false ? "different-owner" : CURRENT_OWNER_ID,
          property: {
            id: actualPropertyId,
            version: opts.propertyVersion ?? 1,
            isArchived: opts.propertyArchived ?? false,
            createdBy: opts.propertyCreatedBy ?? "admin-1",
            assignedTo: opts.propertyAssignedTo ?? null,
          },
        });
      }
      // propertyId_ownerId 経由（target already linked のチェック）
      if (where.propertyId_ownerId) {
        return Promise.resolve(opts.targetLinked ? { id: "existing-po" } : null);
      }
      return Promise.resolve(null);
    },
  );
  // pm.property.findUnique は scope precheck では使われない（PropertyOwner.include
  // 経由）。execute route の tx 内 lock 失敗後の再読込でのみ使用される。
  pm.property.findUnique.mockResolvedValue({
    id: PROPERTY_ID,
    version: opts.propertyVersion ?? 1,
    isArchived: opts.propertyArchived ?? false,
    createdBy: opts.propertyCreatedBy ?? "admin-1",
    assignedTo: opts.propertyAssignedTo ?? null,
  });
  pm.owner.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === CURRENT_OWNER_ID) {
        return Promise.resolve({
          id: CURRENT_OWNER_ID,
          version: 1,
          isArchived: opts.currentArchived ?? false,
        });
      }
      if (where.id === TARGET_OWNER_ID) {
        if (opts.targetExists === false) return Promise.resolve(null);
        return Promise.resolve({
          id: TARGET_OWNER_ID,
          version: 2,
          isArchived: opts.targetArchived ?? false,
        });
      }
      return Promise.resolve(null);
    },
  );
  pm.ownerMemo.count.mockResolvedValue(opts.memoCount ?? 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "admin@test.com",
    name: "Admin",
    role: "admin",
  });
  vi.mocked(getUserPermissions).mockResolvedValue(FULL_PERMS);
});

describe("POST mislink-preview: 権限・入力検証", () => {
  it("user_management:read なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "owner", action: "read", granted: true },
      { resource: "property", action: "read", granted: true },
    ]);
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("operation 不正 → 400", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "invalid",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("UUID 不正 → 400", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: "not-a-uuid",
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("same_owner_id → 422", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("same_owner_id");
  });

  it("field_staff + 担当外 property → 404 (generic, scope leak 防止)", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
    // PropertyOwner の所属 property が field-1 のスコープ外
    setupValidState({
      propertyCreatedBy: "other-1",
      propertyAssignedTo: "other-2",
    });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    // 詳細 reason を返さず generic 404（存在推測 oracle 防止）
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.eligible).toBeUndefined();
    expect(json.blockReasons).toBeUndefined();
  });

  it("field_staff: PropertyOwner 不存在 → 404", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
    setupValidState({ poExists: false });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("scope 外 PropertyOwner で詳細 reason を返さない（target archived も漏れない）", async () => {
    // field_staff が「アクセス可能な propertyId」+「スコープ外 propertyOwnerId」
    // を投げても、target_owner_archived 等の詳細診断が漏れないこと。
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
    setupValidState({
      propertyCreatedBy: "other-1",
      propertyAssignedTo: "other-2",
      targetArchived: true,
      poOwnerMatch: false,
    });
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
      }),
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    // 詳細 blockReason が漏れていない
    expect(text).not.toContain("target_owner_archived");
    expect(text).not.toContain("current_owner_id_mismatch");
    expect(text).not.toContain("version_mismatch");
  });
});

describe("POST mislink-preview: eligible 判定", () => {
  it("remove preview eligible → 200 / eligible=true", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(json.operation).toBe("remove");
  });

  it("relink preview eligible → 200 / eligible=true", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eligible).toBe(true);
  });

  it("target_already_linked → blocker", async () => {
    setupValidState({ targetLinked: true });
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
      }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("target_already_linked");
  });

  it("target_owner_archived → blocker", async () => {
    setupValidState({ targetArchived: true });
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
      }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("target_owner_archived");
  });

  it("missing_target_for_relink → blocker", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        // targetOwnerId 省略
      }),
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("missing_target_for_relink");
  });

  it("ownerMemoCountOnThisProperty が summary に出る", async () => {
    setupValidState({ memoCount: 3 });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    const json = await res.json();
    expect(json.summary.ownerMemoCountOnThisProperty).toBe(3);
  });
});

describe("POST mislink-preview: PII 非露出", () => {
  it("response に owner名・住所が含まれない", async () => {
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    const text = await res.text();
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(PROPERTY_ADDRESS);
  });

  it("AuditLog detail に PII が含まれない", async () => {
    setupValidState();
    await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(OWNER_NAME);
    expect(serialized).not.toContain(PROPERTY_ADDRESS);
    // 許可される ID は含まれる
    expect(call.detail).toMatchObject({
      operation: "remove",
      propertyId: PROPERTY_ID,
      propertyOwnerId: PROPERTY_OWNER_ID,
      currentOwnerId: CURRENT_OWNER_ID,
    });
  });
});

// ── 操作ごとの権限 (発注者判断 2026-08-21) ────────────────────────────
//   付け替え(relink) = 事務担当も可 / 外す(remove) = 管理者だけ。
//   ⚠下見だけ緩い/厳しいがあると、画面は出るのに実行で 403 になる(逆も然り)。
//   **下見と実行で同じ規則**にする。
describe("POST mislink-preview: 操作ごとの権限", () => {
  const OFFICE_STAFF_PERMS = [
    { resource: "owner", action: "read", granted: true },
    { resource: "property", action: "read", granted: true },
  ];

  it("事務担当(user_management:read なし)でも 付け替え の下見はできる", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(OFFICE_STAFF_PERMS);
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("事務担当は 外す の下見ができない(403)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(OFFICE_STAFF_PERMS);
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("owner:read が無ければ 付け替え の下見もできない(緩めすぎていない)", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    setupValidState();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
      }),
    );
    expect(res.status).toBe(403);
  });
});
