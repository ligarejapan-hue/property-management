/**
 * POST /api/owners/[id]/memos: archived owner / merge race ガードテスト。
 *
 * Phase 2-B-β: merge execute と直列化するため、memo POST も transaction 内で
 * owner.updateMany({ where: { id, isArchived: false }, data: { updatedAt } })
 * で行ロックを取得してから OwnerMemo.create する設計。
 *
 * - tx 内 lock の where に isArchived: false が含まれる
 * - lock count=0（archived 化 or 不存在）で 404、create 呼ばれない
 * - AuditLog にメモ本文が入らない
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
      { resource: "owner", action: "read", granted: true },
      { resource: "owner", action: "write", granted: true },
      { resource: "owner_note", action: "edit", granted: true },
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

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { updateMany: vi.fn() },
    ownerMemo: { create: vi.fn() },
  };
  return {
    default: {
      owner: { findUnique: vi.fn() },
      property: { findUnique: vi.fn() },
      propertyOwner: { findFirst: vi.fn() },
      ownerMemo: { findMany: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/owners/[id]/memos/route";

const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMO_BODY = "営業履歴メモ本文";

const pm = prisma as unknown as {
  owner: { findUnique: Mock };
  property: { findUnique: Mock };
  propertyOwner: { findFirst: Mock };
  ownerMemo: { findMany: Mock };
  $transaction: Mock;
  _tx: {
    owner: { updateMany: Mock };
    ownerMemo: { create: Mock };
  };
};

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/owners/${OWNER_ID}/memos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  pm.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(pm._tx),
  );
  pm.owner.findUnique.mockResolvedValue({
    id: OWNER_ID,
    isArchived: false,
  });
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
  pm._tx.ownerMemo.create.mockResolvedValue({
    id: "memo-new",
    ownerId: OWNER_ID,
    propertyId: null,
    body: MEMO_BODY,
    createdAt: new Date(),
    creator: null,
    property: null,
  });
});

describe("POST /api/owners/[id]/memos: archived owner / merge race ガード", () => {
  it("active owner への memo 作成成功 / tx 内 lock が { id, isArchived: false } で発火", async () => {
    const res = await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(res.status).toBe(201);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: { id: OWNER_ID, isArchived: false },
      data: expect.objectContaining({ updatedAt: expect.any(Date) }),
    });
    expect(pm._tx.ownerMemo.create).toHaveBeenCalledTimes(1);
  });

  it("事前確認時点で archived → 404 / tx に入らない / create 呼ばれない", async () => {
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      isArchived: true,
    });
    const res = await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("レース: 事前確認 active → tx 内 lock count=0（concurrent archive / merge） → 404 / create 呼ばれない", async () => {
    // 事前確認は active
    pm.owner.findUnique.mockResolvedValue({
      id: OWNER_ID,
      isArchived: false,
    });
    // tx 内で isArchived=false 条件にマッチせず count=0
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(res.status).toBe(404);
    // archived owner に memo を残さない
    expect(pm._tx.ownerMemo.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("tx 内 lock は data に updatedAt のみ。version / isArchived を勝手に書き換えない", async () => {
    await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    const call = pm._tx.owner.updateMany.mock.calls[0][0];
    expect(call.data).not.toHaveProperty("version");
    expect(call.data).not.toHaveProperty("isArchived");
  });

  it("owner 不存在 → 404 / tx に入らない", async () => {
    pm.owner.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(res.status).toBe(404);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("AuditLog detail に memo 本文が含まれない", async () => {
    await POST(makeRequest({ body: MEMO_BODY }), makeParams());
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(call.detail);
    expect(serialized).not.toContain(MEMO_BODY);
    expect(call.detail).toMatchObject({
      ownerId: OWNER_ID,
      bodyLength: MEMO_BODY.length,
    });
  });
});
