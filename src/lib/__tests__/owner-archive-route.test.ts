/**
 * POST /api/admin/owners/[ownerId]/correction/archive route tests.
 *
 * - dryRun の default は true
 * - dryRun=true は DB 更新・AuditLog・ChangeLog を書かない
 * - 実行時のみ owner:delete を必須
 * - transaction 内で safety を再評価
 * - レスポンス・AuditLog detail に PII を含めない
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
    getApiSession: vi.fn().mockResolvedValue({
      id: "user-1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    }),
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
    owner: { findUnique: vi.fn(), updateMany: vi.fn() },
    changeLog: { count: vi.fn(), createMany: vi.fn() },
    importJobRow: { findMany: vi.fn() },
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      changeLog: { count: vi.fn() },
      importJobRow: { findMany: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/[ownerId]/correction/archive/route";

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER_NAME = "田中太郎";
const OWNER_ADDRESS = "東京都千代田区1-1";

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  changeLog: { count: Mock };
  importJobRow: { findMany: Mock };
  $transaction: Mock;
  _tx: {
    owner: { findUnique: Mock; updateMany: Mock };
    changeLog: { count: Mock; createMany: Mock };
    importJobRow: { findMany: Mock };
  };
};

function makeRequest(body: unknown) {
  return new Request(
    `http://localhost/api/admin/owners/${OWNER_ID}/correction/archive`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ ownerId: OWNER_ID }) });

const PERMS_FULL = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "delete", granted: true },
];

const PERMS_NO_DELETE = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

// Owner row (eligible for archive)
const eligibleOwner = {
  id: OWNER_ID,
  version: 1,
  isArchived: false,
  note: null,
  externalLinkKey: null,
  name: OWNER_NAME,
  address: OWNER_ADDRESS,
  _count: { propertyOwners: 0 },
};

function setupEligible() {
  pm.owner.findUnique.mockResolvedValue(eligibleOwner);
  pm.changeLog.count.mockResolvedValue(0);
  pm.importJobRow.findMany.mockResolvedValue([
    { id: "row-1", status: "success" },
  ]);
  // transaction recheck reuses tx mocks
  pm._tx.owner.findUnique.mockResolvedValue(eligibleOwner);
  pm._tx.changeLog.count.mockResolvedValue(0);
  pm._tx.importJobRow.findMany.mockResolvedValue([
    { id: "row-1", status: "success" },
  ]);
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
});

// ── tests ─────────────────────────────────────────────────────────────────

describe("POST /api/admin/owners/[ownerId]/correction/archive", () => {
  it("dryRun=true (default), eligible → executed=false, blockReasons=[]", async () => {
    setupEligible();
    const res = await POST(makeRequest({ version: 1 }), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.executed).toBe(false);
    expect(body.eligible).toBe(true);
    expect(body.blockReasons).toEqual([]);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("dryRun=true, PropertyOwner あり → blockReasons に property_owner_exists", async () => {
    pm.owner.findUnique.mockResolvedValue({
      ...eligibleOwner,
      _count: { propertyOwners: 2 },
    });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: true }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.executed).toBe(false);
    expect(body.eligible).toBe(false);
    expect(body.blockReasons).toContain("property_owner_exists");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("dryRun=false 成功 → isArchived 反映 / version+1 / ChangeLog & AuditLog 書き込み", async () => {
    setupEligible();
    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.executed).toBe(true);
    expect(body.id).toBe(OWNER_ID);
    expect(body.version).toBe(2);
    expect(body.updatedFields).toEqual(["isArchived"]);

    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: {
        id: OWNER_ID,
        version: 1,
        isArchived: false,
        propertyOwners: { none: {} },
      },
      data: { isArchived: true, version: { increment: 1 } },
    });
    expect(pm._tx.changeLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          targetTable: "owners",
          targetId: OWNER_ID,
          fieldName: "isArchived",
          oldValue: "false",
          newValue: "true",
          source: "manual",
          changedBy: "user-1",
        },
      ],
    });
    expect(writeAuditLog).toHaveBeenCalledWith({
      userId: "user-1",
      action: "owner_correction_archive",
      targetTable: "owners",
      targetId: OWNER_ID,
      detail: {
        correctionType: "archive",
        dryRun: false,
        updatedFields: ["isArchived"],
      },
    });
  });

  it("dryRun=false, version mismatch（tx 内 updateMany count=0 + 再読込が version 差異）→ 409", async () => {
    setupEligible();
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });
    // updateMany 失敗後の再読込: version が変わっている
    pm._tx.owner.findUnique
      .mockResolvedValueOnce(eligibleOwner) // safety recheck
      .mockResolvedValueOnce({
        version: 2,
        isArchived: false,
        address: OWNER_ADDRESS,
        _count: { propertyOwners: 0 },
      });

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("ARCHIVE_BLOCKED");
    expect(body.error.blockReasons).toEqual(["version_mismatch"]);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("レース: safety check 後に PropertyOwner が作られた場合は 422 + property_owner_exists（linked owner を archive しない）", async () => {
    // 外側 load も tx 内 recheck も 0 件で eligible。
    // updateMany は count=0（直前に PropertyOwner が作られたため）。
    // updateMany 失敗後の再読込で propertyOwners=1 を発見 → property_owner_exists を返す。
    pm.owner.findUnique.mockResolvedValue(eligibleOwner);
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);
    pm._tx.owner.findUnique
      .mockResolvedValueOnce(eligibleOwner) // safety recheck (eligible)
      .mockResolvedValueOnce({
        version: 1,
        isArchived: false,
        address: OWNER_ADDRESS,
        _count: { propertyOwners: 1 }, // ← updateMany 後に発見
      });
    pm._tx.changeLog.count.mockResolvedValue(0);
    pm._tx.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe("ARCHIVE_BLOCKED");
    expect(body.error.blockReasons).toContain("property_owner_exists");
    // isArchived=true を書き込まない
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("archive updateMany の where に propertyOwners: { none: {} } が含まれる", async () => {
    setupEligible();
    await POST(makeRequest({ version: 1, dryRun: false }), makeParams());
    const call = pm._tx.owner.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      propertyOwners: { none: {} },
    });
  });

  it("dryRun=false, PropertyOwner あり → 422 + blockReasons", async () => {
    pm.owner.findUnique.mockResolvedValue({
      ...eligibleOwner,
      _count: { propertyOwners: 1 },
    });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe("ARCHIVE_BLOCKED");
    expect(body.error.blockReasons).toContain("property_owner_exists");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("owner:delete 権限なしで dryRun=false → 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_DELETE);
    setupEligible();

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    expect(res.status).toBe(403);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("owner:delete 権限なしでも dryRun=true は通る", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_DELETE);
    setupEligible();

    const res = await POST(
      makeRequest({ version: 1, dryRun: true }),
      makeParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.executed).toBe(false);
    expect(body.eligible).toBe(true);
  });

  it("owner 不存在 → 404", async () => {
    pm.owner.findUnique.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    expect(res.status).toBe(404);
  });

  it("既に isArchived=true → 404", async () => {
    pm.owner.findUnique.mockResolvedValue({
      ...eligibleOwner,
      isArchived: true,
    });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    expect(res.status).toBe(404);
  });

  it("API レスポンスに PII（name/address）が含まれない", async () => {
    setupEligible();
    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const text = await res.text();
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(OWNER_ADDRESS);
  });

  it("AuditLog detail に PII（name/address）が含まれない", async () => {
    setupEligible();
    await POST(makeRequest({ version: 1, dryRun: false }), makeParams());
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(OWNER_NAME);
    expect(serialized).not.toContain(OWNER_ADDRESS);
  });

  // ── address_missing（address-fill 候補を archive で消さない） ──────────────

  it("address=null の orphan owner → dryRun=true で blocked + address_missing", async () => {
    pm.owner.findUnique.mockResolvedValue({ ...eligibleOwner, address: null });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: true }),
      makeParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.executed).toBe(false);
    expect(body.eligible).toBe(false);
    expect(body.blockReasons).toContain("address_missing");
  });

  it("address=空文字 → dryRun=true で blocked + address_missing", async () => {
    pm.owner.findUnique.mockResolvedValue({ ...eligibleOwner, address: "" });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: true }),
      makeParams(),
    );
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.blockReasons).toContain("address_missing");
  });

  it("address=空白のみ → dryRun=true で blocked + address_missing", async () => {
    pm.owner.findUnique.mockResolvedValue({
      ...eligibleOwner,
      address: "   ",
    });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: true }),
      makeParams(),
    );
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.blockReasons).toContain("address_missing");
  });

  it("address=null で dryRun=false → 422 + address_missing / 実行されない", async () => {
    pm.owner.findUnique.mockResolvedValue({ ...eligibleOwner, address: null });
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("ARCHIVE_BLOCKED");
    expect(body.error.blockReasons).toContain("address_missing");
    // 実際の archive 更新 / ChangeLog / AuditLog は一切走らない
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("dryRun=false で複数 ImportJobRow → 422 + import_source_unsafe", async () => {
    pm.owner.findUnique.mockResolvedValue(eligibleOwner);
    pm.changeLog.count.mockResolvedValue(0);
    pm.importJobRow.findMany.mockResolvedValue([
      { id: "row-1", status: "success" },
      { id: "row-2", status: "success" },
    ]);

    const res = await POST(
      makeRequest({ version: 1, dryRun: false }),
      makeParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.blockReasons).toContain("import_source_unsafe");
  });
});
