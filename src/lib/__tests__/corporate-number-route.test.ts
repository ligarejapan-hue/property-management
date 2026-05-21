/**
 * PATCH /api/owners/[id] の corporateNumber 統合テスト。
 *
 * - owner:write なしで 403
 * - owner_corporate_number 書込権限なしで 403
 * - 13桁正規化で保存される
 * - 12桁/14桁/不正値で 422
 * - ChangeLog に corporateNumber が記録される
 * - AuditLog に法人番号生値が入らない (updatedFields のみ)
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
      email: "a@a",
      name: "A",
      role: "admin",
    }),
    getUserPermissions: vi.fn(),
    getOwnerDisplayConfig: vi.fn().mockResolvedValue({
      name: "full",
      nameKana: "full",
      phone: "full",
      zip: "full",
      address: "full",
      note: "full",
      email: "full",
      corporateNumber: "full",
    }),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      if (error && typeof error === "object" && "issues" in error) {
        return Response.json(
          { error: { message: "validation error", code: "VALIDATION_ERROR" } },
          { status: 422 },
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
vi.mock("@/lib/change-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/change-log")>();
  return {
    ...actual,
    recordChanges: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import { PATCH } from "../../app/api/owners/[id]/route";

const pm = prisma as unknown as {
  owner: {
    findUnique: Mock;
    findUniqueOrThrow: Mock;
    updateMany: Mock;
  };
};

const OWNER_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/owners/${OWNER_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

const makeParams = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

const PERMS_FULL = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  { resource: "owner_address", action: "full", granted: true },
  { resource: "owner_corporate_number", action: "full", granted: true },
];

const PERMS_NO_CORP_WRITE = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "full", granted: true },
  // owner_corporate_number は付与しない
];

const PERMS_NO_OWNER_WRITE = [
  { resource: "owner", action: "read", granted: true },
  // owner:write は付与しない
  { resource: "owner_corporate_number", action: "full", granted: true },
];

const baseOwner = {
  id: OWNER_ID,
  name: "株式会社テスト",
  nameKana: null,
  phone: null,
  zip: null,
  address: null,
  note: null,
  email: null,
  corporateNumber: null,
  version: 1,
  isArchived: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  pm.owner.findUnique.mockResolvedValue(baseOwner);
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.owner.findUniqueOrThrow.mockResolvedValue({
    ...baseOwner,
    version: 2,
    corporateNumber: "1234567890123",
    propertyOwners: [],
  });
});

describe("PATCH /api/owners/[id] — corporateNumber", () => {
  it("13桁数字を保存する", async () => {
    const res = await PATCH(
      makeRequest({ version: 1, corporateNumber: "1234567890123" }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    const updateCall = pm.owner.updateMany.mock.calls[0][0];
    expect(updateCall.data.corporateNumber).toBe("1234567890123");
  });

  it("ハイフン混じりを 13桁に正規化して保存する", async () => {
    await PATCH(
      makeRequest({ version: 1, corporateNumber: "1234-5678-9012-3" }),
      makeParams(),
    );
    const updateCall = pm.owner.updateMany.mock.calls[0][0];
    expect(updateCall.data.corporateNumber).toBe("1234567890123");
  });

  it("全角数字を 13桁に正規化して保存する", async () => {
    await PATCH(
      makeRequest({ version: 1, corporateNumber: "１２３４５６７８９０１２３" }),
      makeParams(),
    );
    const updateCall = pm.owner.updateMany.mock.calls[0][0];
    expect(updateCall.data.corporateNumber).toBe("1234567890123");
  });

  it("空文字 → null として保存される", async () => {
    await PATCH(
      makeRequest({ version: 1, corporateNumber: "" }),
      makeParams(),
    );
    const updateCall = pm.owner.updateMany.mock.calls[0][0];
    expect(updateCall.data.corporateNumber).toBeNull();
  });

  it("null をそのまま保存できる", async () => {
    await PATCH(
      makeRequest({ version: 1, corporateNumber: null }),
      makeParams(),
    );
    const updateCall = pm.owner.updateMany.mock.calls[0][0];
    expect(updateCall.data.corporateNumber).toBeNull();
  });

  it("12桁は 422 (validation error)", async () => {
    const res = await PATCH(
      makeRequest({ version: 1, corporateNumber: "123456789012" }),
      makeParams(),
    );
    expect(res.status).toBe(422);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("14桁は 422", async () => {
    const res = await PATCH(
      makeRequest({ version: 1, corporateNumber: "12345678901234" }),
      makeParams(),
    );
    expect(res.status).toBe(422);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_corporate_number 書込権限なしで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_CORP_WRITE);
    const res = await PATCH(
      makeRequest({ version: 1, corporateNumber: "1234567890123" }),
      makeParams(),
    );
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner:write なしで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_OWNER_WRITE);
    const res = await PATCH(
      makeRequest({ version: 1, corporateNumber: "1234567890123" }),
      makeParams(),
    );
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("ChangeLog に corporateNumber が記録される", async () => {
    await PATCH(
      makeRequest({ version: 1, corporateNumber: "1234567890123" }),
      makeParams(),
    );
    expect(vi.mocked(recordChanges)).toHaveBeenCalled();
    const call = vi.mocked(recordChanges).mock.calls[0][0];
    expect(call.targetTable).toBe("owners");
    expect(call.targetId).toBe(OWNER_ID);
    // trackedFields に corporateNumber が含まれている
    expect(call.trackedFields).toContain("corporateNumber");
    // newValues に corporateNumber が含まれている
    expect((call.newValues as Record<string, unknown>).corporateNumber).toBe(
      "1234567890123",
    );
  });

  it("AuditLog に法人番号生値が含まれない（updatedFields のみ）", async () => {
    const RAW = "1234567890123";
    await PATCH(
      makeRequest({ version: 1, corporateNumber: RAW }),
      makeParams(),
    );
    const call = vi.mocked(writeAuditLog).mock.calls.at(-1)?.[0] as any;
    expect(call.action).toBe("update");
    expect(call.targetTable).toBe("owners");
    expect(call.detail.updatedFields).toContain("corporateNumber");
    // detail に生値が出ない
    expect(JSON.stringify(call.detail)).not.toContain(RAW);
  });
});
