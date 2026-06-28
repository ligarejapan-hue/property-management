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
  getDesign: vi.fn(),
  updateDesign: vi.fn(),
  deleteDesign: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { getDesign, updateDesign, deleteDesign } from "@/lib/sales-sheet/design-service";
import { GET, PUT, DELETE } from "../route";

type PrismaMock = { property: { findUnique: Mock } };
const pm = prisma as unknown as PrismaMock;

const VALID_DOCUMENT = {
  page: { width: 297, height: 210, orientation: "landscape" },
  theme: { fontFamily: "sans-serif", accentColor: "#000000" },
  elements: [],
};

const NOW = new Date("2024-01-15T10:00:00.000Z");

const MOCK_DESIGN = {
  id: "sheet-1",
  propertyId: "p1",
  title: "テスト図面",
  document: VALID_DOCUMENT,
  createdAt: NOW,
  updatedAt: NOW,
  thumbnailUrl: null,
  templateId: null,
  createdBy: "u1",
  updatedBy: "u1",
};

function makeReq(method: string, body?: unknown) {
  return new Request(`http://localhost/api/properties/p1/sales-sheets/sheet-1`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ctx = { params: Promise.resolve({ id: "p1", sheetId: "sheet-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([
    { resource: "property", action: "read", granted: true },
    { resource: "property", action: "write", granted: true },
  ]);
  pm.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u1", assignedTo: null });
  (getDesign as unknown as Mock).mockResolvedValue(MOCK_DESIGN);
  (updateDesign as unknown as Mock).mockResolvedValue({ ok: true, design: { ...MOCK_DESIGN, updatedAt: new Date("2024-01-15T11:00:00.000Z") } });
  (deleteDesign as unknown as Mock).mockResolvedValue(true);
});

// ─── GET [sheetId] ───────────────────────────────────────────────────────────

describe("GET /sales-sheets/[sheetId]", () => {
  it("セッションなしは401", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("認証が必要です"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await GET(makeReq("GET"), ctx);
    expect(res.status).toBe(401);
  });

  it("property:read 権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    const res = await GET(makeReq("GET"), ctx);
    expect(res.status).toBe(403);
  });

  it("物件が存在しない場合は404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await GET(makeReq("GET"), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff が他人の物件にアクセスすると403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await GET(makeReq("GET"), ctx);
    expect(res.status).toBe(403);
  });

  it("設計が存在しない場合（または物件スコープ外）は404", async () => {
    (getDesign as unknown as Mock).mockResolvedValue(null);
    const res = await GET(makeReq("GET"), ctx);
    expect(res.status).toBe(404);
  });

  it("正常時は設計データを返す (200)", async () => {
    const res = await GET(makeReq("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("sheet-1");
    expect(body.title).toBe("テスト図面");
    expect(body.document).toBeDefined();
  });

  it("getDesign に propertyId と sheetId を渡す", async () => {
    await GET(makeReq("GET"), ctx);
    expect(getDesign).toHaveBeenCalledWith("p1", "sheet-1");
  });
});

// ─── PUT [sheetId] ───────────────────────────────────────────────────────────

describe("PUT /sales-sheets/[sheetId]", () => {
  const validPatch = { document: VALID_DOCUMENT, expectedUpdatedAt: NOW.toISOString() };

  it("セッションなしは401", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("認証が必要です"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(401);
  });

  it("property:write 権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(403);
  });

  it("物件が存在しない場合は404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff が他人の物件にアクセスすると403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(403);
  });

  it("設計が存在しない場合は404 (not_found)", async () => {
    (updateDesign as unknown as Mock).mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(404);
  });

  it("楽観ロック競合は409 (conflict)", async () => {
    (updateDesign as unknown as Mock).mockResolvedValue({ ok: false, reason: "conflict" });
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(409);
  });

  it("document 不正のとき422", async () => {
    (updateDesign as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("invalid document"), {
        issues: [{ path: ["page"], message: "Required" }],
      }),
    );
    const res = await PUT(makeReq("PUT", { document: {}, expectedUpdatedAt: NOW.toISOString() }), ctx);
    expect(res.status).toBe(422);
  });

  it("expectedUpdatedAt が未指定のとき422", async () => {
    const res = await PUT(makeReq("PUT", { document: VALID_DOCUMENT }), ctx);
    expect(res.status).toBe(422);
  });

  it("正常時は200と { updatedAt } を返す", async () => {
    const res = await PUT(makeReq("PUT", validPatch), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updatedAt).toBeDefined();
  });

  it("updateDesign に正しい引数を渡す", async () => {
    await PUT(makeReq("PUT", { title: "新タイトル", document: VALID_DOCUMENT, expectedUpdatedAt: NOW.toISOString() }), ctx);
    expect(updateDesign).toHaveBeenCalledWith(
      "p1",
      "sheet-1",
      expect.objectContaining({
        title: "新タイトル",
        document: VALID_DOCUMENT,
        expectedUpdatedAt: NOW.toISOString(),
      }),
      "u1",
    );
  });
});

// ─── DELETE [sheetId] ────────────────────────────────────────────────────────

describe("DELETE /sales-sheets/[sheetId]", () => {
  it("セッションなしは401", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("認証が必要です"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await DELETE(makeReq("DELETE"), ctx);
    expect(res.status).toBe(401);
  });

  it("property:write 権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([
      { resource: "property", action: "read", granted: true },
    ]);
    const res = await DELETE(makeReq("DELETE"), ctx);
    expect(res.status).toBe(403);
  });

  it("物件が存在しない場合は404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await DELETE(makeReq("DELETE"), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff が他人の物件にアクセスすると403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await DELETE(makeReq("DELETE"), ctx);
    expect(res.status).toBe(403);
  });

  it("設計が存在しない場合は404", async () => {
    (deleteDesign as unknown as Mock).mockResolvedValue(false);
    const res = await DELETE(makeReq("DELETE"), ctx);
    expect(res.status).toBe(404);
  });

  it("正常削除は204を返す", async () => {
    const res = await DELETE(makeReq("DELETE"), ctx);
    expect(res.status).toBe(204);
  });

  it("deleteDesign に propertyId と sheetId を渡す", async () => {
    await DELETE(makeReq("DELETE"), ctx);
    expect(deleteDesign).toHaveBeenCalledWith("p1", "sheet-1");
  });
});
