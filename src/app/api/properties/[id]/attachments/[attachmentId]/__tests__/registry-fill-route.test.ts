/**
 * POST /api/properties/:id/attachments/:attachmentId/registry-fill(「この謄本から基本情報に反映」)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
const { perms, session } = vi.hoisted(() => ({
  perms: { list: [] as { resource: string; action: string; granted: boolean }[] },
  session: { current: { id: "u-1", role: "admin" } },
}));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => session.current),
    getUserPermissions: vi.fn(async () => perms.list),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      return Response.json({ error: { message: String(error) } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/permissions", () => ({
  hasPermission: (list: typeof perms.list, resource: string, action: string) =>
    list.some((p) => p.resource === resource && p.action === action && p.granted),
}));
const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));
const { canAccessPropertyRecord } = vi.hoisted(() => ({ canAccessPropertyRecord: vi.fn(() => true) }));
vi.mock("@/lib/property-access", () => ({ canAccessPropertyRecord }));
const { storage } = vi.hoisted(() => ({
  storage: { keyFromUrl: vi.fn((u: string) => u.replace("/uploads/", "")), read: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));
const { fill } = vi.hoisted(() => ({ fill: vi.fn() }));
vi.mock("@/lib/registry-pdf/fill-areas", () => ({ fillBasicInfoFromRegistryPdfBestEffort: fill }));
const { db } = vi.hoisted(() => ({
  db: { property: { findUnique: vi.fn() }, attachment: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/prisma", () => ({ default: db }));

import { POST } from "@/app/api/properties/[id]/attachments/[attachmentId]/registry-fill/route";

const grant = (...pairs: [string, string][]) =>
  pairs.map(([resource, action]) => ({ resource, action, granted: true }));
const ALL = grant(["property", "write"], ["registry_pdf", "preview"]);
const call = () =>
  POST(new Request("http://t/x", { method: "POST" }) as unknown as NextRequest, {
    params: Promise.resolve({ id: "p-1", attachmentId: "a-1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  perms.list = ALL;
  canAccessPropertyRecord.mockReturnValue(true);
  db.property.findUnique.mockResolvedValue({ id: "p-1", assignedTo: null, createdBy: "u-1" });
  db.attachment.findFirst.mockResolvedValue({ id: "a-1", fileUrl: "/uploads/a.pdf" });
  storage.read.mockResolvedValue({ body: Buffer.from("pdf") });
  fill.mockResolvedValue({ filled: ["lotNumber", "builtYear"], skippedByEditLock: false, unreadable: false });
});

describe("この謄本から基本情報に反映", () => {
  it("★添付を読み、埋めた欄と案内を返す(押した人として書く・閲覧の記録を残す)", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filled).toEqual(["lotNumber", "builtYear"]);
    expect(body.notice).toContain("地番");
    expect(fill).toHaveBeenCalledWith({ propertyId: "p-1", pdf: expect.any(Buffer), changedBy: "u-1" });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "registry_pdf_preview", targetId: "a-1", detail: { propertyId: "p-1" },
    }));
  });

  it("★この物件の、削除されていない謄本だけを読む(一般の書類・別の物件の添付は 404)", async () => {
    await call();
    expect(db.attachment.findFirst.mock.calls[0][0].where).toEqual({ id: "a-1", propertyId: "p-1", type: "registry", isDeleted: false });
    db.attachment.findFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it.each([
    ["物件の編集権限が無い", grant(["registry_pdf", "preview"])],
    ["謄本の閲覧権限が無い", grant(["property", "write"])],
  ])("★%s=403 で読まない", async (_label, list) => {
    perms.list = list;
    expect((await call()).status).toBe(403);
    expect(storage.read).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it("★担当外の物件=403 で読まない", async () => {
    canAccessPropertyRecord.mockReturnValue(false);
    expect((await call()).status).toBe(403);
    expect(fill).not.toHaveBeenCalled();
  });

  it("実体が無い=404", async () => {
    storage.read.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(fill).not.toHaveBeenCalled();
  });

  it("★読めない謄本・入れるものが無いときも理由を返す", async () => {
    fill.mockResolvedValueOnce({ filled: [], skippedByEditLock: false, unreadable: true });
    expect((await (await call()).json()).notice).toContain("読めない");
    fill.mockResolvedValueOnce({ filled: [], skippedByEditLock: false, unreadable: false });
    expect((await (await call()).json()).notice).toContain("新しく入れる項目はありません");
  });
});
