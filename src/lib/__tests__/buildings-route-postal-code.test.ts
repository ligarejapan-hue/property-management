/**
 * 21-C PR-1: Building の create(POST)/update(PATCH) route が postalCode を受理し、
 * prisma へ渡す（保存先へ届く）ことの検証。postalCode 未指定でも既存挙動が壊れない。
 * （Building の create/update schema は route 内 inline のため、route handler を直接呼ぶ。）
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
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  BUILDING_TRACKED_FIELDS: [],
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    building: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { POST } from "../../app/api/buildings/route";
import { PATCH } from "../../app/api/buildings/[id]/route";

const pm = prisma as unknown as {
  building: { create: Mock; update: Mock; findUnique: Mock };
};

const PERMS_WRITE = [{ resource: "property", action: "write", granted: true }];

function postReq(body: unknown) {
  return new Request("http://localhost/api/buildings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/buildings/b1", {
    method: "PATCH",
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
  pm.building.create.mockResolvedValue({ id: "b1", name: "棟", address: "東京" });
  pm.building.update.mockResolvedValue({ id: "b1" });
  pm.building.findUnique.mockResolvedValue({
    id: "b1",
    version: 1,
    name: "棟",
    address: "東京",
    lotNumber: null,
    realEstateNumber: null,
    totalFloors: null,
    totalUnits: null,
    builtYear: null,
    structureType: null,
    managementCompany: null,
    gpsLat: null,
    gpsLng: null,
    note: null,
  });
});

describe("POST /api/buildings — postalCode 受理（21-C PR-1）", () => {
  it("postalCode を prisma.building.create の data に渡す", async () => {
    const res = await POST(
      postReq({ name: "棟A", address: "東京都港区", postalCode: "1050001" }),
    );
    expect(res.status).toBe(201);
    expect(pm.building.create).toHaveBeenCalledTimes(1);
    expect(pm.building.create.mock.calls[0][0].data.postalCode).toBe("1050001");
  });

  it("postalCode 未指定でも create 成功（既存挙動が壊れない）", async () => {
    const res = await POST(postReq({ name: "棟B", address: "東京都港区" }));
    expect(res.status).toBe(201);
    expect(pm.building.create).toHaveBeenCalledTimes(1);
    expect(pm.building.create.mock.calls[0][0].data.address).toBe("東京都港区");
  });
});

describe("PATCH /api/buildings/[id] — postalCode 受理（21-C PR-1）", () => {
  it("postalCode を prisma.building.update の data に渡す", async () => {
    const res = await PATCH(patchReq({ postalCode: "1050001", version: 1 }), {
      params: Promise.resolve({ id: "b1" }),
    });
    expect(res.status).toBe(200);
    expect(pm.building.update).toHaveBeenCalledTimes(1);
    expect(pm.building.update.mock.calls[0][0].data.postalCode).toBe("1050001");
  });

  it("postalCode=null（クリア）を update の data に渡す", async () => {
    const res = await PATCH(patchReq({ postalCode: null, version: 1 }), {
      params: Promise.resolve({ id: "b1" }),
    });
    expect(res.status).toBe(200);
    expect(pm.building.update.mock.calls[0][0].data.postalCode).toBeNull();
  });

  it("postalCode 未指定でも update 成功（既存挙動が壊れない）", async () => {
    const res = await PATCH(patchReq({ address: "新住所", version: 1 }), {
      params: Promise.resolve({ id: "b1" }),
    });
    expect(res.status).toBe(200);
    expect(pm.building.update.mock.calls[0][0].data).not.toHaveProperty(
      "postalCode",
    );
  });
});
