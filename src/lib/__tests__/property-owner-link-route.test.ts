/**
 * POST /api/properties/[id]/owners route tests.
 *
 * Phase 2-A: archive と link の競合対策。
 *   - 同じ owner 行に対する archive と link が同時に走った場合に、
 *     archive 成功後の link が黙って linked-archived 状態を作らないこと。
 *   - link 側 transaction 内で owner.updateMany を発行し、isArchived=false の
 *     行ロックを取得することで archive 側と直列化する。
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
      { resource: "owner", action: "write", granted: true },
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

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn() },
    propertyOwner: { updateMany: vi.fn(), create: vi.fn() },
  };
  return {
    default: {
      property: { findUnique: vi.fn() },
      owner: { findUnique: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { POST } from "../../app/api/properties/[id]/owners/route";

// zod の uuid() 検証は version bit が 1-8 を要求するため v4 形式の UUID を使う
const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";

const pm = prisma as unknown as {
  property: { findUnique: Mock };
  owner: { findUnique: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock };
    propertyOwner: { updateMany: Mock; create: Mock };
  };
};

function makeRequest(body: unknown) {
  return new Request(
    `http://localhost/api/properties/${PROPERTY_ID}/owners`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ id: PROPERTY_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
});

describe("POST /api/properties/[id]/owners — race-safe link", () => {
  it("active owner → tx 内 lock 成功 → PropertyOwner 作成", async () => {
    pm.property.findUnique.mockResolvedValue({ id: PROPERTY_ID });
    pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID, isArchived: false });
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
    pm._tx.propertyOwner.create.mockResolvedValue({
      id: "po-1",
      propertyId: PROPERTY_ID,
      ownerId: OWNER_ID,
      isPrimary: false,
    });

    const res = await POST(
      makeRequest({ ownerId: OWNER_ID, relationship: "所有者" }),
      makeParams(),
    );
    expect(res.status).toBe(201);
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: { id: OWNER_ID, isArchived: false },
      data: expect.objectContaining({ updatedAt: expect.any(Date) }),
    });
    expect(pm._tx.propertyOwner.create).toHaveBeenCalledTimes(1);
  });

  it("レース: 事前確認で active だったが tx 内 updateMany が count=0（=同時 archive で isArchived=true） → 404 / PropertyOwner 作らない", async () => {
    pm.property.findUnique.mockResolvedValue({ id: PROPERTY_ID });
    // 事前確認時点では active
    pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID, isArchived: false });
    // tx 内 updateMany で isArchived=false 条件にマッチせず count=0
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      makeRequest({ ownerId: OWNER_ID, relationship: "所有者" }),
      makeParams(),
    );
    expect(res.status).toBe(404);
    // PropertyOwner は作成されない（archived owner と link しない）
    expect(pm._tx.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("事前確認時点で archived → 早期 404 / tx に入らない", async () => {
    pm.property.findUnique.mockResolvedValue({ id: PROPERTY_ID });
    pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID, isArchived: true });

    const res = await POST(
      makeRequest({ ownerId: OWNER_ID, relationship: "所有者" }),
      makeParams(),
    );
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
    expect(pm._tx.propertyOwner.create).not.toHaveBeenCalled();
  });

  it("link 側 updateMany の where は { id, isArchived: false } のみ（version 等を勝手に書き換えない）", async () => {
    pm.property.findUnique.mockResolvedValue({ id: PROPERTY_ID });
    pm.owner.findUnique.mockResolvedValue({ id: OWNER_ID, isArchived: false });
    pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
    pm._tx.propertyOwner.create.mockResolvedValue({ id: "po-1" });

    await POST(
      makeRequest({ ownerId: OWNER_ID, relationship: "所有者" }),
      makeParams(),
    );
    const call = pm._tx.owner.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: OWNER_ID, isArchived: false });
    // data は updatedAt のみ（version は触らない）
    expect(call.data).not.toHaveProperty("version");
    expect(call.data).not.toHaveProperty("isArchived");
  });
});
