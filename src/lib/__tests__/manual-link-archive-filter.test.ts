/**
 * POST /api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner:
 * archived owner を既存 Owner 候補にしない（Phase 2-A）。
 *
 * - dedup の findMany / findFirst が archived owner を返さないこと
 * - 同名・同住所の archived owner があっても再利用せず、新規 active Owner を作成
 * - active owner と一致した場合は従来どおり再利用
 * - PropertyOwner.create の ownerId が archived owner の id にならないこと
 * - dedup 後〜link 直前に concurrent archive されたら 422 で停止
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
    getUserPermissions: vi.fn().mockResolvedValue([
      { resource: "import", action: "write", granted: true },
    ]),
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

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  PROPERTY_TRACKED_FIELDS: [],
}));

vi.mock("@/lib/reception-owner-link", () => ({
  isReceptionOwnerJobRow: vi.fn().mockReturnValue(true),
  parseRecoveredOwners: vi.fn(),
  hasUsableOwnerInfo: vi.fn().mockReturnValue(true),
  calcPropertyUpdates: vi.fn().mockReturnValue({}),
  isRowEligibleForManualLink: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    importJobRow: {
      updateMany: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    property: { findUnique: vi.fn(), update: vi.fn() },
    owner: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    propertyOwner: { createMany: vi.fn() },
    importJob: { update: vi.fn() },
  };
  return {
    default: {
      importJobRow: { findUnique: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { parseRecoveredOwners } from "@/lib/reception-owner-link";
import { POST } from "../../app/api/import/jobs/[jobId]/rows/[rowId]/manual-link-reception-owner/route";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";
const PROPERTY_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_NAME = "山田太郎";
const OWNER_ADDRESS = "東京都新宿区5-5";

const pm = prisma as unknown as {
  importJobRow: { findUnique: Mock };
  $transaction: Mock;
  _tx: {
    importJobRow: { updateMany: Mock; update: Mock; findMany: Mock };
    property: { findUnique: Mock; update: Mock };
    owner: {
      findMany: Mock;
      findFirst: Mock;
      create: Mock;
      updateMany: Mock;
    };
    propertyOwner: { createMany: Mock };
    importJob: { update: Mock };
  };
};

function makeRequest() {
  return new Request(
    `http://localhost/api/import/jobs/${JOB_ID}/rows/${ROW_ID}/manual-link-reception-owner`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyId: PROPERTY_ID }),
    },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({
  params: Promise.resolve({ jobId: JOB_ID, rowId: ROW_ID }),
});

beforeEach(() => {
  vi.clearAllMocks();
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );

  pm.importJobRow.findUnique.mockResolvedValue({
    id: ROW_ID,
    jobId: JOB_ID,
    rowNumber: 5,
    status: "needs_review",
    createdId: null,
    rawData: {
      __owner_link_data: JSON.stringify([
        { name: OWNER_NAME, address: OWNER_ADDRESS, zip: null },
      ]),
      ownerCount: "1",
      所有者CSV物件住所: OWNER_ADDRESS,
    },
    job: { id: JOB_ID, jobType: "owner_csv" },
  });

  vi.mocked(parseRecoveredOwners).mockReturnValue([
    { name: OWNER_NAME, address: OWNER_ADDRESS, zip: null },
  ]);

  pm._tx.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.property.findUnique.mockResolvedValue({
    lotNumber: null,
    buildingNumber: null,
    roomNo: null,
  });
  pm._tx.owner.create.mockImplementation(
    ({ data }: { data: { name: string } }) =>
      Promise.resolve({ id: `owner-new-${data.name}` }),
  );
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.propertyOwner.createMany.mockResolvedValue({ count: 1 });
  pm._tx.importJobRow.update.mockResolvedValue({});
  pm._tx.importJobRow.findMany.mockResolvedValue([
    { status: "success" },
  ]);
  pm._tx.importJob.update.mockResolvedValue({});
});

describe("POST manual-link-reception-owner: archived owner を再利用しない", () => {
  it("dedup findMany の where に isArchived:false が含まれる", async () => {
    pm._tx.owner.findMany.mockResolvedValue([]);
    pm._tx.owner.findFirst.mockResolvedValue(null);

    await POST(makeRequest(), makeParams());

    expect(pm._tx.owner.findMany).toHaveBeenCalled();
    const dedupCall = pm._tx.owner.findMany.mock.calls.find(
      (c) =>
        c[0]?.where?.address &&
        Object.prototype.hasOwnProperty.call(c[0].where, "isArchived"),
    );
    expect(dedupCall).toBeDefined();
    expect(dedupCall![0].where).toMatchObject({
      address: { not: null },
      isArchived: false,
    });
  });

  it("name-only フォールバック findFirst の where にも isArchived:false が含まれる", async () => {
    // address=null の RecoveredOwner で fallback を走らせる
    vi.mocked(parseRecoveredOwners).mockReturnValue([
      { name: OWNER_NAME, address: null, zip: null },
    ]);
    pm._tx.owner.findFirst.mockResolvedValue(null);

    await POST(makeRequest(), makeParams());

    expect(pm._tx.owner.findFirst).toHaveBeenCalled();
    const fbCall = pm._tx.owner.findFirst.mock.calls[0][0];
    expect(fbCall.where).toMatchObject({
      name: OWNER_NAME,
      address: null,
      isArchived: false,
    });
  });

  it("archived 一致時は再利用せず新規 active Owner を作成し、PropertyOwner はその新規 owner と link する", async () => {
    // DB 側 where: { isArchived: false } で archived は除外されるため findMany は空
    pm._tx.owner.findMany.mockResolvedValue([]);
    pm._tx.owner.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);

    // 新規 owner 作成
    expect(pm._tx.owner.create).toHaveBeenCalledTimes(1);
    expect(pm._tx.owner.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: OWNER_NAME }),
      }),
    );
    // PropertyOwner.createMany の ownerId は新規 owner の id
    expect(pm._tx.propertyOwner.createMany).toHaveBeenCalledTimes(1);
    const createArgs = pm._tx.propertyOwner.createMany.mock.calls[0][0];
    expect(createArgs.data).toEqual([
      expect.objectContaining({
        propertyId: PROPERTY_ID,
        ownerId: `owner-new-${OWNER_NAME}`,
      }),
    ]);
  });

  it("active 一致時は既存 active Owner を再利用、PropertyOwner はそれと link", async () => {
    pm._tx.owner.findMany.mockResolvedValue([
      {
        id: "owner-existing-active",
        name: OWNER_NAME,
        address: OWNER_ADDRESS,
        zip: null,
      },
    ]);
    // 既存 owner branch では lock+verify updateMany が走る → 成功で count=1
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);

    // 新規 owner は作らない
    expect(pm._tx.owner.create).not.toHaveBeenCalled();
    // lock+verify updateMany が isArchived=false を where に含めて呼ばれる
    const lockCall = pm._tx.owner.updateMany.mock.calls.find(
      (c) => c[0]?.where?.id === "owner-existing-active",
    );
    expect(lockCall).toBeDefined();
    expect(lockCall![0].where).toMatchObject({
      id: "owner-existing-active",
      isArchived: false,
    });
    // PropertyOwner は既存 active owner と link
    const createArgs = pm._tx.propertyOwner.createMany.mock.calls[0][0];
    expect(createArgs.data).toEqual([
      expect.objectContaining({
        propertyId: PROPERTY_ID,
        ownerId: "owner-existing-active",
      }),
    ]);
  });

  it("レース: dedup find 後に concurrent archive されたら updateMany count=0 → 422 + PropertyOwner 作らない", async () => {
    pm._tx.owner.findMany.mockResolvedValue([
      {
        id: "owner-was-active",
        name: OWNER_NAME,
        address: OWNER_ADDRESS,
        zip: null,
      },
    ]);
    // lock+verify が isArchived=false にマッチせず count=0
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("OWNER_ARCHIVED");
    // PropertyOwner は作成されない（tx rollback）
    expect(pm._tx.propertyOwner.createMany).not.toHaveBeenCalled();
  });

  it("API レスポンスに PII (name / address) が含まれない", async () => {
    pm._tx.owner.findMany.mockResolvedValue([]);
    pm._tx.owner.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest(), makeParams());
    const text = await res.text();
    expect(text).not.toContain(OWNER_NAME);
    expect(text).not.toContain(OWNER_ADDRESS);
  });

  it("AuditLog detail に PII (name / address) が含まれない", async () => {
    pm._tx.owner.findMany.mockResolvedValue([]);
    pm._tx.owner.findFirst.mockResolvedValue(null);

    await POST(makeRequest(), makeParams());

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(OWNER_NAME);
    expect(serialized).not.toContain(OWNER_ADDRESS);
  });
});
