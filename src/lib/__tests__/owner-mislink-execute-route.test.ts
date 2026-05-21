/**
 * POST /api/admin/owners/correction/mislink execute route tests.
 *
 * - dryRun=false で PropertyOwner.delete / .update
 * - owner / property の version bump
 * - ChangeLog batch (PII フリー)
 * - AuditLog (PII フリー)
 * - race / version mismatch
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

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn(), findUnique: vi.fn() },
    property: { updateMany: vi.fn(), findUnique: vi.fn() },
    propertyOwner: {
      findUnique: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    changeLog: { createMany: vi.fn() },
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      property: { findUnique: vi.fn() },
      propertyOwner: { findUnique: vi.fn() },
      ownerMemo: { count: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/correction/mislink/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_OWNER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_OWNER_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_NAME = "誤紐づき太郎";
const PROPERTY_ADDRESS = "東京都港区テスト1-1";

const FULL_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  property: { findUnique: Mock };
  propertyOwner: { findUnique: Mock };
  ownerMemo: { count: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock; findUnique: Mock };
    property: { updateMany: Mock; findUnique: Mock };
    propertyOwner: {
      findUnique: Mock;
      delete: Mock;
      update: Mock;
    };
    changeLog: { createMany: Mock };
  };
};

function makeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/admin/owners/correction/mislink",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

function setupHappyPath(opts: {
  targetLinked?: boolean;
  memoCount?: number;
  currentArchived?: boolean;
  propertyCreatedBy?: string;
  propertyAssignedTo?: string | null;
  propertyArchived?: boolean;
  poExists?: boolean;
  poPropertyMatch?: boolean;
} = {}) {
  const actualPropertyId =
    opts.poPropertyMatch === false ? "different-prop" : PROPERTY_ID;
  pm.propertyOwner.findUnique.mockImplementation(
    ({ where }: { where: { id?: string; propertyId_ownerId?: { propertyId: string; ownerId: string } } }) => {
      if (where.id === PROPERTY_OWNER_ID) {
        if (opts.poExists === false) return Promise.resolve(null);
        return Promise.resolve({
          id: PROPERTY_OWNER_ID,
          propertyId: actualPropertyId,
          ownerId: CURRENT_OWNER_ID,
          // Phase 2-C fix: PropertyOwner.include({ property }) で scope 判定
          property: {
            id: actualPropertyId,
            version: 1,
            isArchived: opts.propertyArchived ?? false,
            createdBy: opts.propertyCreatedBy ?? "admin-1",
            assignedTo: opts.propertyAssignedTo ?? null,
          },
        });
      }
      if (where.propertyId_ownerId) {
        return Promise.resolve(opts.targetLinked ? { id: "existing-po" } : null);
      }
      return Promise.resolve(null);
    },
  );
  pm.property.findUnique.mockResolvedValue({
    id: PROPERTY_ID,
    version: 1,
    isArchived: false,
    createdBy: "admin-1",
    assignedTo: null,
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
        return Promise.resolve({
          id: TARGET_OWNER_ID,
          version: 2,
          isArchived: false,
        });
      }
      return Promise.resolve(null);
    },
  );
  pm.ownerMemo.count.mockResolvedValue(opts.memoCount ?? 0);

  // tx default
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.property.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.propertyOwner.findUnique.mockImplementation(
    ({ where }: { where: { id?: string; propertyId_ownerId?: { propertyId: string; ownerId: string } } }) => {
      if (where.id === PROPERTY_OWNER_ID) {
        return Promise.resolve({
          id: PROPERTY_OWNER_ID,
          propertyId: PROPERTY_ID,
          ownerId: CURRENT_OWNER_ID,
        });
      }
      if (where.propertyId_ownerId) {
        return Promise.resolve(opts.targetLinked ? { id: "existing-po" } : null);
      }
      return Promise.resolve(null);
    },
  );
  pm._tx.propertyOwner.delete.mockResolvedValue({});
  pm._tx.propertyOwner.update.mockResolvedValue({});
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 0 });
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
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
});

// ── 権限・入力 ────────────────────────────────────────────────────────────

describe("POST mislink: 権限・入力", () => {
  it("owner:write なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      FULL_PERMS.filter(
        (p) => !(p.resource === "owner" && p.action === "write"),
      ),
    );
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("property:write なし → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(
      FULL_PERMS.filter(
        (p) => !(p.resource === "property" && p.action === "write"),
      ),
    );
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("version 不正 → 400", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 0,
        propertyVersion: 1,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("same_owner_id → 422", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 1,
        propertyVersion: 1,
      }),
    );
    expect(res.status).toBe(422);
  });
});

// ── Scope leak 防止（Codex P1） ─────────────────────────────────────────

describe("POST mislink: object-scope precheck（scope leak 防止）", () => {
  it("dryRun=true で field_staff + スコープ外 PropertyOwner → 404 / 詳細reason漏れない / DB更新なし", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
    // PropertyOwner.property が field-1 のスコープ外
    setupHappyPath({
      propertyCreatedBy: "other-1",
      propertyAssignedTo: "other-2",
    });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: true,
      }),
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    // 詳細 reason が漏れていない
    expect(text).not.toContain("current_owner_id_mismatch");
    expect(text).not.toContain("version_mismatch");
    expect(text).not.toContain("target_owner_archived");
    // DB 更新なし
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("dryRun=false で field_staff + スコープ外 PropertyOwner → 404 / 詳細reason漏れない / DB更新なし / AuditLog なし", async () => {
    vi.mocked(getApiSession).mockResolvedValue({
      id: "field-1",
      email: "field@test.com",
      name: "Field",
      role: "field_staff",
    });
    setupHappyPath({
      propertyCreatedBy: "other-1",
      propertyAssignedTo: "other-2",
    });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("PropertyOwner 不存在 → 404 (どちらも generic)", async () => {
    setupHappyPath({ poExists: false });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("admin はスコープ外でも詳細 reason を受け取れる（既存挙動維持）", async () => {
    // admin / office_staff は canAccessPropertyRecord が常に true
    setupHappyPath({
      propertyCreatedBy: "other-1",
      propertyAssignedTo: "other-2",
    });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: true,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.eligible).toBe(true);
  });
});

// ── dryRun=true ──────────────────────────────────────────────────────────

describe("POST mislink: dryRun=true", () => {
  it("eligible remove → 200 / executed=false / DB 更新なし", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: true,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.eligible).toBe(true);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("dryRun default は true", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
      }),
    );
    const json = await res.json();
    expect(json.executed).toBe(false);
  });
});

// ── execute remove ─────────────────────────────────────────────────────

describe("POST mislink: execute remove", () => {
  it("dryRun=false で PropertyOwner.delete + version bump + ChangeLog + AuditLog", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(json.operation).toBe("remove");
    expect(json.result.removed).toBe(true);
    expect(json.result.previousOwnerId).toBe(CURRENT_OWNER_ID);
    expect(json.result.currentOwnerVersion).toBe(2);
    expect(json.result.propertyVersion).toBe(2);

    // PropertyOwner.delete
    expect(pm._tx.propertyOwner.delete).toHaveBeenCalledWith({
      where: { id: PROPERTY_OWNER_ID },
    });
    // currentOwner.version bump
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: { id: CURRENT_OWNER_ID, version: 1 },
      data: { version: { increment: 1 } },
    });
    // property.version bump
    expect(pm._tx.property.updateMany).toHaveBeenCalledWith({
      where: { id: PROPERTY_ID, version: 1, isArchived: false },
      data: { version: { increment: 1 } },
    });
    // ChangeLog
    const cl = pm._tx.changeLog.createMany.mock.calls[0]?.[0];
    expect(cl?.data).toContainEqual(
      expect.objectContaining({
        targetTable: "property_owners",
        targetId: PROPERTY_OWNER_ID,
        fieldName: "_deleted_via_mislink_correction",
        oldValue: CURRENT_OWNER_ID,
        newValue: null,
      }),
    );
    // AuditLog PII フリー
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "owner_correction_mislink",
        targetTable: "property_owners",
        targetId: PROPERTY_OWNER_ID,
        detail: expect.objectContaining({
          operation: "remove",
          dryRun: false,
          previousOwnerId: CURRENT_OWNER_ID,
          newOwnerId: null,
        }),
      }),
    );
    const auditDetailStr = JSON.stringify(
      vi.mocked(writeAuditLog).mock.calls[0][0].detail,
    );
    expect(auditDetailStr).not.toContain(OWNER_NAME);
    expect(auditDetailStr).not.toContain(PROPERTY_ADDRESS);
  });

  it("currentOwner archived でも remove 成功", async () => {
    setupHappyPath({ currentArchived: true });
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(true);
  });
});

// ── execute relink ─────────────────────────────────────────────────────

describe("POST mislink: execute relink", () => {
  it("dryRun=false で PropertyOwner.update + 全 version bump + ChangeLog 2 件", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 2,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(json.operation).toBe("relink");
    expect(json.result.removed).toBe(false);
    expect(json.result.newOwnerId).toBe(TARGET_OWNER_ID);
    expect(json.result.currentOwnerVersion).toBe(2);
    expect(json.result.targetOwnerVersion).toBe(3);
    expect(json.result.propertyVersion).toBe(2);

    // PropertyOwner.update
    expect(pm._tx.propertyOwner.update).toHaveBeenCalledWith({
      where: { id: PROPERTY_OWNER_ID },
      data: { ownerId: TARGET_OWNER_ID },
    });
    // targetOwner.version bump (isArchived: false 含む)
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: { id: TARGET_OWNER_ID, version: 2, isArchived: false },
      data: { version: { increment: 1 } },
    });
    // ChangeLog 2 件
    const cl = pm._tx.changeLog.createMany.mock.calls[0]?.[0];
    expect(cl?.data).toContainEqual(
      expect.objectContaining({
        targetTable: "property_owners",
        fieldName: "ownerId",
        oldValue: CURRENT_OWNER_ID,
        newValue: TARGET_OWNER_ID,
      }),
    );
    expect(cl?.data).toContainEqual(
      expect.objectContaining({
        targetTable: "property_owners",
        fieldName: "_relinked_via_mislink_correction",
      }),
    );
  });

  it("target_already_linked → blocked / update なし", async () => {
    setupHappyPath({ targetLinked: true });
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 2,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("target_already_linked");
    expect(pm._tx.propertyOwner.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── race / version ───────────────────────────────────────────────────────

describe("POST mislink: race / version mismatch", () => {
  it("propertyVersion 不一致 → 409 (事前チェック)", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 999,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(409);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("currentOwnerVersion 不一致 → 409", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 999,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(409);
  });

  it("targetOwnerVersion 不一致 → 409", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 999,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(409);
  });

  it("tx 内で PropertyOwner が消えていた場合 → 404 / PropertyOwner.delete 呼ばれない", async () => {
    // not_found 系は 404 (PropertyOwner row が並行 race で消失したケース)
    setupHappyPath();
    pm._tx.propertyOwner.findUnique.mockResolvedValue(null);
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
    expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
  });

  it("tx 内で Property が消えていた場合 → 404", async () => {
    setupHappyPath();
    // property の updateMany lock が count=0
    pm._tx.property.updateMany.mockResolvedValue({ count: 0 });
    // 再読込でも null → property_not_found
    pm._tx.property.findUnique.mockResolvedValue(null);
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("tx 内で currentOwner が消えていた場合 → 404", async () => {
    setupHappyPath();
    // currentOwner の updateMany lock が count=0
    pm._tx.owner.updateMany.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === CURRENT_OWNER_ID) return Promise.resolve({ count: 0 });
        return Promise.resolve({ count: 1 });
      },
    );
    // 再読込で null → current_owner_not_found
    pm._tx.owner.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === CURRENT_OWNER_ID) return Promise.resolve(null);
        return Promise.resolve({ id: where.id, version: 1, isArchived: false });
      },
    );
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("relink で tx 内 targetOwner が消えていた場合 → 404", async () => {
    setupHappyPath();
    // targetOwner の updateMany lock が count=0
    pm._tx.owner.updateMany.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === TARGET_OWNER_ID) return Promise.resolve({ count: 0 });
        return Promise.resolve({ count: 1 });
      },
    );
    pm._tx.owner.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        if (where.id === TARGET_OWNER_ID) return Promise.resolve(null);
        return Promise.resolve({ id: where.id, version: 1, isArchived: false });
      },
    );
    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 2,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(404);
    expect(pm._tx.propertyOwner.update).not.toHaveBeenCalled();
  });

  it("tx 内 property_owner_state_mismatch は引き続き 422", async () => {
    setupHappyPath();
    pm._tx.propertyOwner.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; propertyId_ownerId?: unknown } }) => {
        if (where.id === PROPERTY_OWNER_ID) {
          return Promise.resolve({
            id: PROPERTY_OWNER_ID,
            propertyId: "different-prop-now",
            ownerId: CURRENT_OWNER_ID,
          });
        }
        return Promise.resolve(null);
      },
    );
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("property_owner_state_mismatch");
  });

  it("tx 内で PropertyOwner.ownerId が currentOwnerId とズレ → 422 / current_owner_id_mismatch", async () => {
    setupHappyPath();
    pm._tx.propertyOwner.findUnique.mockImplementation(
      ({ where }: { where: { id?: string; propertyId_ownerId?: unknown } }) => {
        if (where.id === PROPERTY_OWNER_ID) {
          return Promise.resolve({
            id: PROPERTY_OWNER_ID,
            propertyId: PROPERTY_ID,
            ownerId: "different-owner-now",
          });
        }
        return Promise.resolve(null);
      },
    );
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    // not_found ではなく 422 (並行更新で内容が変わったケース)
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("current_owner_id_mismatch");
  });

  it("tx 内で target owner が archived 化 → target_owner_archived", async () => {
    setupHappyPath();
    // 事前確認では active
    // tx 内 lock updateMany を archive 検出方向に振る
    pm._tx.owner.updateMany.mockImplementation(
      ({ where }: { where: { id: string; isArchived?: boolean } }) => {
        if (where.id === TARGET_OWNER_ID && where.isArchived === false) {
          return Promise.resolve({ count: 0 });
        }
        return Promise.resolve({ count: 1 });
      },
    );
    pm._tx.owner.findUnique.mockResolvedValue({
      id: TARGET_OWNER_ID,
      version: 2,
      isArchived: true,
    });

    const res = await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 2,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    const json = await res.json();
    expect(json.error.blockReasons).toContain("target_owner_archived");
    expect(pm._tx.propertyOwner.update).not.toHaveBeenCalled();
  });
});

// ── PII 非露出 ────────────────────────────────────────────────────────────

describe("POST mislink: PII 非露出", () => {
  it("response に owner名・住所が含まれない", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        operation: "remove",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        currentOwnerVersion: 1,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    const text = await res.text();
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(PROPERTY_ADDRESS);
  });

  it("ChangeLog に PII を含めない（ID のみ）", async () => {
    setupHappyPath();
    await POST(
      makeRequest({
        operation: "relink",
        propertyId: PROPERTY_ID,
        propertyOwnerId: PROPERTY_OWNER_ID,
        currentOwnerId: CURRENT_OWNER_ID,
        targetOwnerId: TARGET_OWNER_ID,
        currentOwnerVersion: 1,
        targetOwnerVersion: 2,
        propertyVersion: 1,
        dryRun: false,
      }),
    );
    const cl = pm._tx.changeLog.createMany.mock.calls[0]?.[0];
    expect(cl).toBeDefined();
    const serialized = JSON.stringify(cl.data);
    expect(serialized).not.toContain(OWNER_NAME);
    expect(serialized).not.toContain(PROPERTY_ADDRESS);
  });
});
