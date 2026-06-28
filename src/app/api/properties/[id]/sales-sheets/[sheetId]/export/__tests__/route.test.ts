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
}));

vi.mock("@/lib/sales-sheet/authorize-document-images", () => ({
  authorizeAndInlineDocumentImages: vi.fn(),
}));

vi.mock("@/lib/sales-sheet/output", () => ({
  isChromiumAvailable: vi.fn(),
}));

vi.mock("@/lib/sales-sheet/render-to-output", () => ({
  renderDocumentToPdf: vi.fn(),
  renderDocumentToImage: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { getDesign } from "@/lib/sales-sheet/design-service";
import { authorizeAndInlineDocumentImages } from "@/lib/sales-sheet/authorize-document-images";
import { isChromiumAvailable } from "@/lib/sales-sheet/output";
import { renderDocumentToPdf, renderDocumentToImage } from "@/lib/sales-sheet/render-to-output";
import { POST } from "../route";

type PrismaMock = { property: { findUnique: Mock } };
const pm = prisma as unknown as PrismaMock;

const VALID_DOCUMENT = {
  page: { width: 297, height: 210, orientation: "landscape" },
  theme: { fontFamily: "sans-serif", accentColor: "#000000" },
  elements: [],
};

const MOCK_DESIGN = {
  id: "sheet-1",
  propertyId: "p1",
  title: "テスト図面",
  document: VALID_DOCUMENT,
  createdAt: new Date("2024-01-15T10:00:00.000Z"),
  updatedAt: new Date("2024-01-15T10:00:00.000Z"),
  thumbnailUrl: null,
  templateId: null,
  createdBy: "u1",
  updatedBy: "u1",
};

function makeReq(format?: string) {
  const url = format
    ? `http://localhost/api/properties/p1/sales-sheets/sheet-1/export?format=${format}`
    : "http://localhost/api/properties/p1/sales-sheets/sheet-1/export";
  return new Request(url, { method: "POST" });
}

const ctx = { params: Promise.resolve({ id: "p1", sheetId: "sheet-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([
    { resource: "property", action: "read", granted: true },
  ]);
  pm.property.findUnique.mockResolvedValue({ id: "p1", createdBy: "u1", assignedTo: null });
  (getDesign as unknown as Mock).mockResolvedValue(MOCK_DESIGN);
  (authorizeAndInlineDocumentImages as unknown as Mock).mockImplementation(
    async (doc: unknown) => doc,
  );
  (isChromiumAvailable as unknown as Mock).mockReturnValue(true);
  (renderDocumentToPdf as unknown as Mock).mockResolvedValue(Buffer.from("%PDF-1.4"));
  (renderDocumentToImage as unknown as Mock).mockResolvedValue(Buffer.from("\x89PNG"));
});

describe("POST /sales-sheets/[sheetId]/export", () => {
  it("セッションなしは401", async () => {
    (getApiSession as unknown as Mock).mockRejectedValue(
      Object.assign(new Error("認証が必要です"), { status: 401, code: "UNAUTHORIZED" }),
    );
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(401);
  });

  it("property:read 権限なしは403", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(403);
  });

  it("物件が存在しない場合は404", async () => {
    pm.property.findUnique.mockResolvedValue(null);
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(404);
  });

  it("field_staff が他人の物件にアクセスすると403", async () => {
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "other", role: "field_staff" });
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(403);
  });

  it("設計が存在しない場合（または物件スコープ外）は404", async () => {
    (getDesign as unknown as Mock).mockResolvedValue(null);
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(404);
  });

  it("document が破損している場合は422", async () => {
    (getDesign as unknown as Mock).mockResolvedValue({
      ...MOCK_DESIGN,
      document: { broken: true },
    });
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(422);
  });

  it("chromium が利用できない場合は503", async () => {
    (isChromiumAvailable as unknown as Mock).mockReturnValue(false);
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(503);
  });

  it("format 指定なし（既定 pdf）→ 200 application/pdf", async () => {
    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("format=pdf → 200 application/pdf", async () => {
    const res = await POST(makeReq("pdf"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("format=png → 200 image/png", async () => {
    const res = await POST(makeReq("png"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("authorizeAndInlineDocumentImages に session と permissions を渡す", async () => {
    await POST(makeReq(), ctx);
    expect(authorizeAndInlineDocumentImages).toHaveBeenCalledWith(
      VALID_DOCUMENT,
      expect.objectContaining({ session: expect.objectContaining({ id: "u1" }) }),
    );
  });

  it("renderDocumentToPdf は authorizeAndInlineDocumentImages 後の doc を受け取る", async () => {
    const transformedDoc = { ...VALID_DOCUMENT, elements: [] };
    (authorizeAndInlineDocumentImages as unknown as Mock).mockResolvedValue(transformedDoc);
    await POST(makeReq(), ctx);
    expect(renderDocumentToPdf).toHaveBeenCalledWith(transformedDoc);
  });

  it("出力レスポンスは Cache-Control: no-store", async () => {
    const resPdf = await POST(makeReq(), ctx);
    expect(resPdf.headers.get("Cache-Control")).toBe("no-store");
    const resPng = await POST(makeReq("png"), ctx);
    expect(resPng.headers.get("Cache-Control")).toBe("no-store");
  });
});
