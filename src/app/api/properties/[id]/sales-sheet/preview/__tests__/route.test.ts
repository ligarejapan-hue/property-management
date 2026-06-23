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
vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findUnique: vi.fn(async () =>
        ({ id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null, photos: [] }),
      ),
    },
  },
}));
vi.mock("@/lib/sales-sheet/render-to-output", () => ({ renderDocumentToPdf: vi.fn() }));
vi.mock("@/lib/sales-sheet/output", () => ({ isChromiumAvailable: vi.fn(() => true) }));
vi.mock("@/lib/sales-sheet/build-document", () => ({ buildInitialSalesSheetDocument: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/uploads-authorization", () => ({
  authorizeUploadAccess: vi.fn(async () => "ok"),
}));

// Backend-aware keyFromUrl: handles both /uploads/{key} (local) and /{bucket}/{key} (server)
const mockKeyFromUrl = vi.fn((url: string | null | undefined): string | null => {
  if (typeof url !== "string") return null;
  const uploadsPrefix = "/uploads/";
  if (url.startsWith(uploadsPrefix)) return url.slice(uploadsPrefix.length);
  // server backend: /{bucket}/{key}
  const serverMatch = /^\/[^/]+\/(.+)$/.exec(url);
  if (serverMatch) return serverMatch[1];
  return null;
});
vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => ({ keyFromUrl: mockKeyFromUrl })),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { renderDocumentToPdf } from "@/lib/sales-sheet/render-to-output";
import { buildInitialSalesSheetDocument } from "@/lib/sales-sheet/build-document";
import { authorizeUploadAccess } from "@/lib/uploads-authorization";
import { getStorage } from "@/lib/storage";
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
  pm.property.findUnique.mockResolvedValue({ id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null, photos: [] });
  (renderDocumentToPdf as unknown as Mock).mockResolvedValue(Buffer.from("%PDF-1.4 test"));
  (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
  // Restore backend-aware keyFromUrl implementation after vi.clearAllMocks()
  mockKeyFromUrl.mockImplementation((url: string | null | undefined): string | null => {
    if (typeof url !== "string") return null;
    const uploadsPrefix = "/uploads/";
    if (url.startsWith(uploadsPrefix)) return url.slice(uploadsPrefix.length);
    const serverMatch = /^\/[^/]+\/(.+)$/.exec(url);
    if (serverMatch) return serverMatch[1];
    return null;
  });
  (getStorage as unknown as Mock).mockReturnValue({ keyFromUrl: mockKeyFromUrl });
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
  it("土地以外の物件は400(NOT_LAND)", async () => {
    pm.property.findUnique.mockResolvedValue({ id: "p1", address: "addr", propertyType: "house", createdBy: "u1", assignedTo: null, building: null, photos: [] });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_LAND");
  });
  it("成功時は application/pdf を返す", async () => {
    const res = await POST(req({ price: "3,480万円" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    // Verify the photo-fallback query shape: orderBy with isPrimary desc, sortOrder asc, take 1
    const call = pm.property.findUnique.mock.calls[0][0];
    expect(call.include.photos.orderBy).toEqual([
      { isPrimary: "desc" },
      { sortOrder: "asc" },
    ]);
    expect(call.include.photos.take).toBe(1);
  });

  // P1 IDOR photo authorization tests
  it("写真のストレージキーが認可済みなら写真付きでドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null,
      photos: [{ fileUrl: "/uploads/properties/p1/photo.jpg" }],
    });
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.photo).toEqual({ fileUrl: "/uploads/properties/p1/photo.jpg" });
    // authorizeUploadAccess was called for the photo key
    expect(authorizeUploadAccess as unknown as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "properties/p1/photo.jpg" }),
    );
  });

  it("写真キーが forbidden なら photo:null でドキュメントを構築し、バイトを読み込まない (P1 IDOR)", async () => {
    // Simulate: photo fileUrl resolves to another property's key → authorizeUploadAccess returns forbidden
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null,
      photos: [{ fileUrl: "/uploads/properties/OTHER/photo.jpg" }],
    });
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    // photo must be null — unauthorized bytes must NOT be embedded
    expect(buildCall.photo).toBeNull();
  });

  it("写真キーが not_found なら photo:null でドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null,
      photos: [{ fileUrl: "/uploads/properties/p1/missing.jpg" }],
    });
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("not_found");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.photo).toBeNull();
  });

  it("写真 fileUrl からキーが解決できない場合は photo:null でドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null,
      photos: [{ fileUrl: "data:image/jpeg;base64,AAAA" }],
    });
    // data: URI resolves to null in all backends
    mockKeyFromUrl.mockReturnValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.photo).toBeNull();
    // authorizeUploadAccess must NOT be called when key is unresolvable
    expect(authorizeUploadAccess as unknown as Mock).not.toHaveBeenCalled();
  });

  // P2 server backend: /{bucket}/{key} URL形式の写真鍵をbackend対応keyFromUrlで解決する
  it("server backend形式 /{bucket}/{key} のfileUrlも認可され写真付きでドキュメントを構築する (P2)", async () => {
    const serverFileUrl = "/property-management/properties/p1/x.jpg";
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null,
      photos: [{ fileUrl: serverFileUrl }],
    });
    // server backend keyFromUrl resolves /{bucket}/{key} → key
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("ok");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    // photo is included because keyFromUrl resolved the server-style URL
    expect(buildCall.photo).toEqual({ fileUrl: serverFileUrl });
    // authorizeUploadAccess was called with the extracted key (without bucket prefix)
    expect(authorizeUploadAccess as unknown as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "properties/p1/x.jpg" }),
    );
  });

  it("server backend形式 /{bucket}/{key} でauthorize forbidden なら photo:null (P2)", async () => {
    const serverFileUrl = "/property-management/properties/OTHER/x.jpg";
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null, building: null,
      photos: [{ fileUrl: serverFileUrl }],
    });
    (authorizeUploadAccess as unknown as Mock).mockResolvedValue("forbidden");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.photo).toBeNull();
  });

  // 現況ラベル日本語変換 (Codex P2)
  it("現況 vacant → 空室 に変換してドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null,
      occupancyStatus: "vacant", building: null, photos: [],
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.property.occupancyStatus).toBe("空室");
  });

  it("現況 occupied → 入居中 に変換してドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null,
      occupancyStatus: "occupied", building: null, photos: [],
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.property.occupancyStatus).toBe("入居中");
  });

  it("現況 unknown → 不明 に変換してドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null,
      occupancyStatus: "unknown", building: null, photos: [],
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.property.occupancyStatus).toBe("不明");
  });

  it("現況 null → null のままドキュメントを構築する", async () => {
    pm.property.findUnique.mockResolvedValue({
      id: "p1", address: "addr", propertyType: "land", createdBy: "u1", assignedTo: null,
      occupancyStatus: null, building: null, photos: [],
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const buildCall = (buildInitialSalesSheetDocument as unknown as Mock).mock.calls[0][0];
    expect(buildCall.property.occupancyStatus).toBeNull();
  });
});
