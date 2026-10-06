/**
 * 「部屋を追加」(POST /api/buildings/[id]/properties)の不具合修正(設計 2026-10-04 §4.4)。
 * 以前は種別が旧値 "unit"・物件名が空で作っていた。区分マンション・物件名=棟の名前で作り、
 * 棟へのつなぎは共通の処理(applyBuildingLink)を通す。
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
    getOwnerDisplayConfig: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      return Response.json(
        { error: { message: e.message ?? "err", code: e.code ?? "ERROR" } },
        { status: e.status ?? 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

const { applyMock, auditLinkMock, txMock } = vi.hoisted(() => ({
  applyMock: vi.fn(),
  auditLinkMock: vi.fn(),
  txMock: { property: { create: vi.fn() } },
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/building-link/apply", () => ({
  applyBuildingLink: applyMock,
  writeBuildingLinkAudit: auditLinkMock,
}));
vi.mock("@/lib/prisma", () => {
  const prisma = {
    building: { findUnique: vi.fn() },
    property: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(txMock)),
  };
  return { default: prisma, prisma };
});

import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../properties/route";

const pm = prisma as unknown as {
  building: { findUnique: Mock };
  property: { create: Mock };
};

const ctx = { params: Promise.resolve({ id: "b1" }) };
function req(body: unknown) {
  return new Request("http://localhost/api/buildings/b1/properties", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({ id: "user-1", email: "a@a", name: "A", role: "admin" } as never);
  vi.mocked(getUserPermissions).mockResolvedValue([{ resource: "property", action: "write", granted: true }]);
  pm.building.findUnique.mockResolvedValue({ id: "b1", name: "パークハウス第一" });
  txMock.property.create.mockResolvedValue({ id: "p1", propertyType: "apartment_unit", buildingId: null });
  applyMock.mockResolvedValue({
    action: "linked", building: { id: "b1", name: "パークハウス第一" },
    previousBuildingId: null, renamedFrom: null, warnings: [],
  });
});

describe("部屋を追加 → 棟へつなぐ", () => {
  it("区分マンション・物件名=棟の名前で作り、その棟へつなぐ", async () => {
    const res = await POST(req({ address: "東京都大田区南雪谷1丁目1", roomNo: "101" }), ctx);
    expect(res.status).toBe(201);
    const data = txMock.property.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ propertyType: "apartment_unit", buildingName: "パークハウス第一", roomNo: "101" });
    expect(data).not.toHaveProperty("buildingId");
    expect(pm.property.create).not.toHaveBeenCalled(); // tx の外では作らない
    expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      propertyId: "p1",
      propertyType: "apartment_unit",
      choice: { kind: "existing", buildingId: "b1" },
      buildingName: "パークハウス第一",
      currentBuildingId: null,
      buildingNumber: null,
      userId: "user-1",
    }));
    const json = await res.json();
    expect(json.buildingId).toBe("b1");
    expect(auditLinkMock).toHaveBeenCalledWith("user-1", "p1", expect.objectContaining({ action: "linked" }));
  });

  it("作成の監査ログの種別は apartment_unit", async () => {
    await POST(req({ address: "東京都大田区南雪谷1丁目1" }), ctx);
    expect(vi.mocked(writeAuditLog).mock.calls[0][0]).toMatchObject({
      detail: expect.objectContaining({ propertyType: "apartment_unit" }),
    });
  });
});
