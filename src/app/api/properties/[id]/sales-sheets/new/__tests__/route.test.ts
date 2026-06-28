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
    handleApiError: vi.fn((e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string; issues?: unknown[] };
      if (typeof err?.status === "number") {
        return Response.json(
          { error: { message: err.message, code: err.code } },
          { status: err.status },
        );
      }
      if (Array.isArray(err?.issues)) {
        return Response.json(
          { error: { message: "invalid input", code: "VALIDATION_ERROR" } },
          { status: 422 },
        );
      }
      return Response.json(
        { error: { message: "internal", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (
      perms: { resource: string; action: string; granted: boolean }[],
      resource: string,
      action: string,
    ) => perms.some((p) => p.resource === resource && p.action === action && p.granted),
  ),
}));

vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(
    (
      session: { id: string; role: string },
      property: { createdBy: string; assignedTo: string | null },
    ) => {
      if (session.role !== "field_staff") return true;
      return property.createdBy === session.id || property.assignedTo === session.id;
    },
  ),
}));

const LAND_PROPERTY = {
  id: "p1",
  createdBy: "u1",
  assignedTo: null,
  propertyType: "land",
  address: "東京都新宿区1-1-1",
  zoningDistrict: null,
  buildingCoverageRatio: null,
  floorAreaRatio: null,
  roadType: null,
  roadWidth: null,
  occupancyStatus: null,
};

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(async () => LAND_PROPERTY),
    },
    propertyOwner: {
      findFirst: vi.fn(async () => null),
    },
    propertyPhoto: {
      findFirst: vi.fn(async () => null),
    },
  },
}));

vi.mock("@/lib/sales-sheet/design-service", () => ({
  createDesign: vi.fn(async () => ({ id: "sheet-1" })),
}));

vi.mock("@/lib/sales-sheet/build-document", () => ({
  buildSaleLandDocument: vi.fn(() => ({
    page: { width: 297, height: 210 },
    theme: {},
    elements: [],
  })),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { createDesign } from "@/lib/sales-sheet/design-service";
import { POST } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  propertyOwner: { findFirst: Mock };
  propertyPhoto: { findFirst: Mock };
};
const pm = prisma as unknown as PrismaMock;

const ADMIN_SESSION = { id: "u1", email: "a@b.com", name: "Admin", role: "admin" };
const WRITE_PERMS = [{ resource: "property", action: "write", granted: true }];

function makeRequest() {
  return new Request("http://localhost/api/properties/p1/sales-sheets/new", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue(ADMIN_SESSION);
  (getUserPermissions as Mock).mockResolvedValue(WRITE_PERMS);
  pm.property.findUnique.mockResolvedValue(LAND_PROPERTY);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyPhoto.findFirst.mockResolvedValue(null);
  (createDesign as Mock).mockResolvedValue({ id: "sheet-1" });
});

describe("POST /api/properties/[id]/sales-sheets/new", () => {
  it("401 — 未認証", async () => {
    (getApiSession as Mock).mockRejectedValue(
      Object.assign(new Error("auth"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(401);
  });

  it("403 — property:write 権限なし", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(403);
  });

  it("404 — 物件が存在しない", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(404);
  });

  it("403 — field_staff がスコープ外物件にアクセス", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "other-user",
      email: "x@y.com",
      name: "Field",
      role: "field_staff",
    });
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, createdBy: "u1", assignedTo: null });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(403);
  });

  it("422 — 土地以外の物件", async () => {
    pm.property.findUnique.mockResolvedValue({ ...LAND_PROPERTY, propertyType: "apartment_unit" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_PROPERTY_TYPE");
  });

  it("201 — 土地物件: design 作成して id を返す", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("sheet-1");
    expect(createDesign).toHaveBeenCalledOnce();
  });

  it("201 — owner・photo が存在する物件でも成功する", async () => {
    pm.propertyOwner.findFirst.mockResolvedValue({ owner: { name: "田中太郎" } });
    pm.propertyPhoto.findFirst.mockResolvedValue({ fileUrl: "/uploads/photo.jpg" });
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
  });
});
