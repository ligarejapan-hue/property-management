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
    parseJsonBody: vi.fn(async (req: Request) => {
      const text = await req.text();
      if (!text.trim()) return {};
      return JSON.parse(text);
    }),
    handleApiError: vi.fn((e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string; issues?: unknown[] };
      if (typeof err?.status === "number") {
        return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status });
      }
      if (Array.isArray(err?.issues)) {
        return Response.json({ error: { message: "invalid input", code: "VALIDATION_ERROR" } }, { status: 422 });
      }
      return Response.json({ error: { message: "internal", code: "INTERNAL_ERROR" } }, { status: 500 });
    }),
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (perms: { resource: string; action: string; granted: boolean }[], resource: string, action: string) =>
      perms.some((p) => p.resource === resource && p.action === action && p.granted),
  ),
}));

vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(
    (session: { id: string; role: string }, property: { createdBy: string; assignedTo: string | null }) => {
      if (session.role !== "field_staff") return true;
      return property.createdBy === session.id || property.assignedTo === session.id;
    },
  ),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(async () => ({ id: "p1", createdBy: "u1", assignedTo: null })),
    },
  },
}));

vi.mock("@/lib/sales-sheet/design-service", () => ({
  createDesign: vi.fn(),
  listDesigns: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { createDesign, listDesigns } from "@/lib/sales-sheet/design-service";
import { writeAuditLog } from "@/lib/audit";
import { GET, POST } from "../route";

type PrismaMock = { property: { findUnique: Mock } };
const pm = prisma as unknown as PrismaMock;

const VALID_DOCUMENT = {
  page: { width: 297, height: 210, orientation: "landscape" },
  theme: { fontFamily: "sans-serif", accentColor: "#000000" },
  elements: [],
};

function postReq(body: unknown) {
  return new Request("http://localhost/api/properties/p1/sales-sheets", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getReq() {
  return new Request("http://localhost/api/properties/p1/sales-sheets", {
    method: "GET",
  });
}

const ctx = { params: Promise.resolve({ id: "p1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([
    { resource: "property", action: "read", granted: true },
    { resource: "property", action: "write", granted: true },
  ]);
  pm.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u1", assignedTo: null });
  (listDesigns as unknown as Mock).mockResolvedValue([]);
  (createDesign as unknown as Mock).mockResolvedValue({ id: "design-1" });
});

describe("GET /sales-sheets (list)", () => {
  it("セッションなしは401", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("認証が必要です"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(401);
  });

  it("property:read 権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(403);
  });

  it("物件が存在しない場合は404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff が他人の物件にアクセスすると403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(403);
  });

  it("正常時は一覧を返す (200)", async () => {
    const designs = [{ id: "d1", title: "図面A", updatedAt: new Date(), createdAt: new Date(), thumbnailUrl: null }];
    (listDesigns as unknown as Mock).mockResolvedValue(designs);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("d1");
  });

  it("listDesigns に propertyId を渡す", async () => {
    await GET(getReq(), ctx);
    expect(listDesigns).toHaveBeenCalledWith("p1");
  });
});

describe("POST /sales-sheets (create)", () => {
  it("セッションなしは401", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("認証が必要です"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await POST(postReq({ document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(401);
  });

  it("property:write 権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await POST(postReq({ document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(403);
  });

  it("物件が存在しない場合は404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(postReq({ document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff が他人の物件にアクセスすると403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await POST(postReq({ document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(403);
  });

  it("title が120文字超のとき422", async () => {
    const res = await POST(postReq({ title: "x".repeat(121), document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(422);
  });

  it("document 不正のとき422", async () => {
    (createDesign as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("invalid document"), {
        issues: [{ path: ["page"], message: "Required" }],
      }),
    );
    const res = await POST(postReq({ document: {} }), ctx);
    expect(res.status).toBe(422);
  });

  it("正常時は201と { id } を返す", async () => {
    const res = await POST(postReq({ document: VALID_DOCUMENT, title: "テスト図面" }), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: "design-1" });
  });

  it("createDesign に正しい引数を渡す", async () => {
    await POST(postReq({ document: VALID_DOCUMENT, title: "テスト", templateId: "t1" }), ctx);
    expect(createDesign).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "p1",
        title: "テスト",
        document: VALID_DOCUMENT,
        templateId: "t1",
        userId: "u1",
      }),
    );
  });

  it("作成成功時に AuditLog を1件記録する（非PIIメタのみ）", async () => {
    const res = await POST(postReq({ document: VALID_DOCUMENT, title: "テスト図面" }), ctx);
    expect(res.status).toBe(201);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const arg = (writeAuditLog as unknown as Mock).mock.calls[0][0];
    expect(arg).toMatchObject({
      userId: "u1",
      action: "sales_sheet_design_create",
      targetTable: "sales_sheet_designs",
      targetId: "design-1",
      detail: { propertyId: "p1" },
    });
    expect(Object.keys(arg.detail as object)).toEqual(["propertyId"]);
  });

  it("権限なし(403)では AuditLog を記録しない", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await POST(postReq({ document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(403);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
