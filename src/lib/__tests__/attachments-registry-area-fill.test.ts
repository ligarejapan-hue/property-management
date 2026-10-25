/**
 * POST /api/properties/[id]/attachments — 謄本PDFを添付したら面積を読んで物件の空の欄に入れる(2026-10-25)。
 *   - 謄本(registry)のときだけ読む・謄本以外では読まない
 *   - 読んだ PDF は受け取ったファイルそのもの・書くのは添付した人として
 * 設定(モック)は attachments-doc-classify-route.test.ts と同じ。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "u-admin", role: "admin" })),
    getUserPermissions: vi.fn(async () => [
      { resource: "property", action: "read", granted: true },
      { resource: "property", action: "write", granted: true },
    ]),
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

const { fillAreasFromRegistryPdfBestEffort } = vi.hoisted(() => ({
  fillAreasFromRegistryPdfBestEffort: vi.fn(async () => ({ filled: [], skippedByEditLock: false })),
}));
vi.mock("@/lib/registry-pdf/fill-areas", () => ({ fillAreasFromRegistryPdfBestEffort }));

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
  extractTextFromPdf.mockResolvedValue("");
});

describe("謄本PDFの添付で面積を入れる", () => {
  it("★謄本を添付したら、その PDF を読んで面積を入れる(添付は 201)", async () => {
    const res = await POST(await req("謄本.pdf", "application/pdf", "registry"), params);
    expect(res.status).toBe(201);
    expect(fillAreasFromRegistryPdfBestEffort).toHaveBeenCalledTimes(1);
    const arg = (fillAreasFromRegistryPdfBestEffort.mock.calls[0] as unknown as [{ propertyId: string; pdf: Buffer; changedBy: string }])[0];
    expect(arg.propertyId).toBe("p-1");
    expect(arg.changedBy).toBe("u-admin");
    expect(Buffer.compare(arg.pdf, PDF_HEAD)).toBe(0);
  });

  it("謄本以外の添付では読まない", async () => {
    await POST(await req("売買契約書.pdf", "application/pdf"), params);
    expect(fillAreasFromRegistryPdfBestEffort).not.toHaveBeenCalled();
  });
});
