import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
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
    handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
      Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 })),
  };
});
vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn((perms: { resource: string; action: string; granted: boolean }[], resource: string, action: string) =>
    perms.some((p) => p.resource === resource && p.action === action && p.granted)),
}));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn((session: { id: string; role: string }, property: { createdBy: string; assignedTo: string | null }) => {
    if (session.role !== "field_staff") return true;
    return property.createdBy === session.id || property.assignedTo === session.id;
  }),
}));
vi.mock("@/lib/prisma", () => ({ default: { property: { findUnique: vi.fn() } } }));
vi.mock("@/lib/sales-sheet/render-to-output", () => ({ renderDocumentToPdf: vi.fn() }));
vi.mock("@/lib/sales-sheet/output", () => ({ isChromiumAvailable: vi.fn(() => true) }));
vi.mock("@/lib/sales-sheet/build-document", () => ({ buildInitialSalesSheetDocument: vi.fn(async () => ({ ok: true })) }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { renderDocumentToPdf } from "@/lib/sales-sheet/render-to-output";
import { POST } from "../route";

type PrismaMock = { property: { findUnique: Mock } };
const pm = prisma as unknown as PrismaMock;

function req(body: unknown = {}) {
  return new Request("http://localhost/api/properties/p1/sales-sheet/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: "p1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([{ resource: "property", action: "read", granted: true }]);
  pm.property.findUnique.mockResolvedValue({ id: "p1", address: "addr", createdBy: "u1", assignedTo: null, building: null, photos: [] });
  (renderDocumentToPdf as unknown as Mock).mockResolvedValue(Buffer.from("%PDF-1.4 test"));
});

describe("POST sales-sheet/preview", () => {
  it("権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });
  it("物件が無ければ404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });
  it("field_staff が他人の物件なら403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });
  it("成功時は application/pdf を返す", async () => {
    const res = await POST(req({ price: "3,480万円" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });
});
