/**
 * 21-C PR-1 (Codex P2): unit 作成経路 POST /api/buildings/[id]/properties が
 * postalCode を受理し prisma.property.create へ渡すこと。unit も Property 実体ゆえ
 * 主経路 /api/properties と同様に postalCode を保存する（API 一貫性）。
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
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e.message ?? "err", code: e.code ?? "ERROR" } },
        { status: e.status ?? 500 },
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
    building: { findUnique: vi.fn() },
    property: { create: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../../app/api/buildings/[id]/properties/route";

const pm = prisma as unknown as {
  building: { findUnique: Mock };
  property: { create: Mock };
};

const PERMS_WRITE = [{ resource: "property", action: "write", granted: true }];

function postReq(body: unknown) {
  return new Request("http://localhost/api/buildings/b1/properties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    email: "a@a",
    name: "A",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_WRITE);
  pm.building.findUnique.mockResolvedValue({ id: "b1", name: "棟" });
  pm.property.create.mockResolvedValue({ id: "p1", propertyType: "unit" });
});

describe("POST /api/buildings/[id]/properties — unit postalCode 受理（21-C PR-1 Codex P2）", () => {
  it("postalCode を prisma.property.create の data に渡す", async () => {
    const res = await POST(
      postReq({ address: "東京都港区1-1 101号室", postalCode: "1050001" }),
      { params: Promise.resolve({ id: "b1" }) },
    );
    expect(res.status).toBe(201);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(pm.property.create.mock.calls[0][0].data.postalCode).toBe("1050001");
    expect(pm.property.create.mock.calls[0][0].data.propertyType).toBe("unit");
  });

  it("postalCode=null を data に渡す", async () => {
    const res = await POST(
      postReq({ address: "東京都港区1-1 102号室", postalCode: null }),
      { params: Promise.resolve({ id: "b1" }) },
    );
    expect(res.status).toBe(201);
    expect(pm.property.create.mock.calls[0][0].data.postalCode).toBeNull();
  });

  it("postalCode 未指定でも create 成功（既存挙動が壊れない）", async () => {
    const res = await POST(
      postReq({ address: "東京都港区1-1 103号室" }),
      { params: Promise.resolve({ id: "b1" }) },
    );
    expect(res.status).toBe(201);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(pm.property.create.mock.calls[0][0].data.address).toBe(
      "東京都港区1-1 103号室",
    );
  });
});
