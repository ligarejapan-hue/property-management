/**
 * POST /api/properties/[id]/attachments — 謄本を添付したら登記状況を自動で取得済に(2026-11-06)。
 *   - 謄本(registry)のときだけ・謄本以外の添付では呼ばない
 *   - 物件を編集できない人の添付は断られ、状態も変わらない
 *   (未取得からだけ上げる・取得中/取得済は変えない、の中身は registry-status-auto.test.ts)
 * 設定(モック)は attachments-registry-area-fill.test.ts と同じ。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
const { perms } = vi.hoisted(() => ({ perms: { list: [] as { resource: string; action: string; granted: boolean }[] } }));
const WRITER = [
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "u-admin", role: "admin" })),
    getUserPermissions: vi.fn(async () => perms.list),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json({ error: { message: error.message, code: error.code } }, { status: error.status });
      }
      return Response.json({ error: { message: String(error) } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
const { storageStub } = vi.hoisted(() => ({
  storageStub: { upload: vi.fn(async () => ({ url: "/uploads/x.pdf" })), delete: vi.fn(), getUrl: vi.fn(), read: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({
  getStorage: () => storageStub,
  MAX_FILE_SIZE: 8 * 1024 * 1024,
  ALLOWED_ATTACHMENT_MIMES: new Set(["image/png", "application/pdf"]),
  validateFile: () => null,
}));
const { fitPdfToLimit, reserveLargePdfSlot } = vi.hoisted(() => ({
  fitPdfToLimit: vi.fn(async (buf: Buffer) => ({ buffer: buf, originalSize: null, level: null })),
  reserveLargePdfSlot: vi.fn(() => () => {}),
}));
vi.mock("@/lib/pdf-compress/fit", () => ({ fitPdfToLimit, reserveLargePdfSlot }));
const { extractTextFromPdf } = vi.hoisted(() => ({ extractTextFromPdf: vi.fn() }));
vi.mock("@/lib/pdf-extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf-extract")>();
  // route は先頭ページだけ読む extractHeadTextFromPdf を使う。
  return { ...actual, extractHeadTextFromPdf: extractTextFromPdf };
});
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(async () => ({
        id: "p-1", createdBy: "u-admin", assignedTo: null,
        buildingName: "ハマイハイライズ", roomNo: "305号室", address: "東京都…",
      })),
    },
    attachment: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a-1", ...data })),
    },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p-1" }]);
  return { default: db };
});

const { fillBasicInfoFromRegistryPdfBestEffort } = vi.hoisted(() => ({
  fillBasicInfoFromRegistryPdfBestEffort: vi.fn(async () => ({ filled: [] as string[], skippedByEditLock: false, unreadable: false })),
}));
vi.mock("@/lib/registry-pdf/fill-areas", () => ({ fillBasicInfoFromRegistryPdfBestEffort }));

const { autoMarkRegistryObtainedBestEffort } = vi.hoisted(() => ({
  autoMarkRegistryObtainedBestEffort: vi.fn(async () => true),
}));
vi.mock("@/lib/registry-status-auto", () => ({ autoMarkRegistryObtainedBestEffort }));

import { POST } from "@/app/api/properties/[id]/attachments/route";

const PDF_HEAD = Buffer.from("%PDF-1.4\n%fake\n");

async function req(name: string, mime: string, type?: string, bytes: Buffer = PDF_HEAD) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
  if (type) fd.append("type", type);
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/properties/p-1/attachments", {
    method: "POST", body: blob,
    headers: { "content-type": blob.type, "content-length": String(blob.size) },
  }) as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: "p-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  perms.list = WRITER;
  extractTextFromPdf.mockResolvedValue("");
});

describe("謄本の添付で登記状況を取得済に", () => {
  it("★謄本を添付したら、その物件を添付した人として取得済にする", async () => {
    const res = await POST(await req("謄本.pdf", "application/pdf", "registry"), params);
    expect(res.status).toBe(201);
    expect(autoMarkRegistryObtainedBestEffort).toHaveBeenCalledWith({ propertyId: "p-1", changedBy: "u-admin" });
  });

  it("★謄本以外の添付では変えない", async () => {
    const res = await POST(await req("売買契約書.pdf", "application/pdf"), params);
    expect(res.status).toBe(201);
    expect(autoMarkRegistryObtainedBestEffort).not.toHaveBeenCalled();
  });

  it("★物件を編集できない人の添付は断られ、状態も変わらない", async () => {
    perms.list = [{ resource: "property", action: "read", granted: true }];
    const res = await POST(await req("謄本.pdf", "application/pdf", "registry"), params);
    expect(res.status).toBe(403);
    expect(autoMarkRegistryObtainedBestEffort).not.toHaveBeenCalled();
  });

  it("切り替えに失敗しても(false)、添付は成功のまま", async () => {
    autoMarkRegistryObtainedBestEffort.mockResolvedValueOnce(false);
    const res = await POST(await req("謄本.pdf", "application/pdf", "registry"), params);
    expect(res.status).toBe(201);
  });
});
