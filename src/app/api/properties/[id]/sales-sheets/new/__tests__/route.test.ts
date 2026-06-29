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
    // 実 parseJsonBody と同じ挙動: 空ボディ→{} / 不正JSON→throw。
    parseJsonBody: vi.fn(async (req: Request) => {
      const text = await req.text();
      return text.trim() === "" ? {} : JSON.parse(text);
    }),
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

// createDesign: DB書き込みはモック。ただし parseSalesSheetDocument を通じた
// document 検証は実行する（旧 data:only バリデータでは /uploads/ src が 422 を返す
// ことをこのテストで検出できるようにするため）。
vi.mock("@/lib/sales-sheet/design-service", async () => {
  const { parseSalesSheetDocument } = await import("@/lib/sales-sheet/document-schema");
  return {
    createDesign: vi.fn(async (input: { document: unknown }) => {
      parseSalesSheetDocument(input.document); // invalid document は throw → handleApiError が 422 を返す
      return { id: "sheet-1" };
    }),
  };
});

// 代表写真の保存前認可（caller 認可＋物件所属）。既定 true、テストで上書き。
vi.mock("@/lib/sales-sheet/authorize-document-images", () => ({
  isImageKeyAuthorizedForProperty: vi.fn(async () => true),
}));

// buildSaleLandDocument はモックしない — 実関数でドキュメントを組むことで
// /uploads/ src が document に含まれるパスを実際にバリデーション経路に通す。

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { createDesign } from "@/lib/sales-sheet/design-service";
import { isImageKeyAuthorizedForProperty } from "@/lib/sales-sheet/authorize-document-images";
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
  (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(true);
  // createDesign: vi.clearAllMocks() でコール履歴はリセットされるが
  // vi.mock ファクトリで設定した実装（parseSalesSheetDocument 検証）は保持される。
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

  it("201 — owner・photo が存在する物件でも成功する（認可OKの写真は入る）", async () => {
    pm.propertyOwner.findFirst.mockResolvedValue({ owner: { name: "田中太郎" } });
    pm.propertyPhoto.findFirst.mockResolvedValue({ fileUrl: "/uploads/photo.jpg" });
    (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(true);
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201);
    const doc = (createDesign as Mock).mock.calls[0][0].document as { elements: { type: string }[] };
    expect(doc.elements.some((e) => e.type === "image")).toBe(true); // 写真が入る
  });

  it("201 — 認可NG/別物件の写真は document に入れず「写真なし初期図面」で作成", async () => {
    pm.propertyPhoto.findFirst.mockResolvedValue({ fileUrl: "/uploads/photo.jpg" });
    (isImageKeyAuthorizedForProperty as Mock).mockResolvedValue(false); // caller NG または別物件
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(201); // 拒否ではなく写真 drop で作成
    const doc = (createDesign as Mock).mock.calls[0][0].document as { elements: { type: string }[] };
    expect(doc.elements.some((e) => e.type === "image")).toBe(false); // 写真は入っていない
  });
});
