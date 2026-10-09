/**
 * 物件の添付: 大きい PDF の自動圧縮(2026-10-10・発注者決定 2026-10-09)。
 *   - 謄本以外の PDF は、上限(8MB)を超えたら縮めて保存し、圧縮前の大きさを残す
 *   - 謄本(registry)は縮めない=従来どおり 8MB で断る(課金した原本)
 *   - PDF 以外(Excel・画像など)は従来どおり 8MB で断る
 *   - 受け取る上限(50MB)を超える PDF は、読む前に断る
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});

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

const { writeAuditLog } = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAuditLog }));

const { storageStub } = vi.hoisted(() => ({
  storageStub: { upload: vi.fn(async () => ({ url: "/uploads/x.pdf" })), delete: vi.fn(), getUrl: vi.fn(), read: vi.fn() },
}));
vi.mock("@/lib/storage", () => {
  const MAX = 8 * 1024 * 1024;
  const ATTACH = new Set(["image/png", "application/pdf", "application/vnd.ms-excel"]);
  return {
    getStorage: () => storageStub,
    MAX_FILE_SIZE: MAX,
    ALLOWED_ATTACHMENT_MIMES: ATTACH,
    validateFile: (size: number, mime: string, allowed: Set<string>) => {
      if (size > MAX) return "ファイルサイズが上限 (8MB) を超えています";
      if (!allowed.has(mime)) return `許可されていないファイル形式です: ${mime}`;
      return null;
    },
  };
});

const { fitPdfToLimit } = vi.hoisted(() => ({ fitPdfToLimit: vi.fn() }));
vi.mock("@/lib/pdf-compress/fit", () => ({ fitPdfToLimit }));

vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: { findUnique: vi.fn(async () => ({ id: "p-1", createdBy: "u-admin", assignedTo: null })) },
    attachment: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a-1", ...data })) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p-1" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { POST } from "@/app/api/properties/[id]/attachments/route";

const create = (prisma as unknown as { attachment: { create: ReturnType<typeof vi.fn> } }).attachment.create;
const MB = 1024 * 1024;

async function req(size: number, mime: string, name: string, type?: string, contentLength?: number) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(size)], { type: mime }), name);
  if (type) fd.append("type", type);
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/properties/p-1/attachments", {
    method: "POST",
    body: blob,
    headers: { "content-type": blob.type, "content-length": String(contentLength ?? blob.size) },
  }) as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: "p-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  fitPdfToLimit.mockImplementation(async (buf: Buffer) => {
    if (buf.length <= 8 * MB) return { buffer: buf, originalSize: null, level: null };
    return { buffer: Buffer.alloc(3 * MB), originalSize: buf.length, level: "jpeg85" };
  });
});

describe("添付: 大きい PDF の自動圧縮", () => {
  it("★8MB を超える通常の PDF は縮めて保存し、圧縮前の大きさを残す", async () => {
    const res = await POST(await req(12 * MB, "application/pdf", "report.pdf"), params);
    expect(res.status).toBe(201);
    expect(fitPdfToLimit).toHaveBeenCalledTimes(1);
    expect(storageStub.upload).toHaveBeenCalledTimes(1);
    expect((storageStub.upload.mock.calls[0] as unknown[])[0]).toHaveLength(3 * MB);
    expect(create.mock.calls[0][0].data).toMatchObject({ fileSize: 3 * MB, originalSize: 12 * MB, type: "general" });
    expect(writeAuditLog.mock.calls[0][0].detail).toMatchObject({ compressedFrom: 12 * MB, compressedTo: 3 * MB });
  });

  it("上限以下の通常の PDF は、そのまま保存する(originalSize は null)", async () => {
    const res = await POST(await req(2 * MB, "application/pdf", "small.pdf"), params);
    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].data).toMatchObject({ fileSize: 2 * MB, originalSize: null });
    expect(writeAuditLog.mock.calls[0][0].detail.compressedFrom).toBeUndefined();
  });

  it("★謄本の PDF は縮めない(8MB を超えたら従来どおり断る・保存しない)", async () => {
    const res = await POST(await req(12 * MB, "application/pdf", "touhon.pdf", "registry"), params);
    expect(res.status).toBe(422);
    expect(fitPdfToLimit).not.toHaveBeenCalled();
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("謄本の PDF は 8MB 以下ならそのまま保存し、圧縮の部品を通さない", async () => {
    const res = await POST(await req(2 * MB, "application/pdf", "touhon.pdf", "registry"), params);
    expect(res.status).toBe(201);
    expect(fitPdfToLimit).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data).toMatchObject({ type: "registry", originalSize: null });
  });

  it("PDF 以外は 8MB を超えたら従来どおり断る(縮めない)", async () => {
    const res = await POST(await req(9 * MB, "application/vnd.ms-excel", "a.xls"), params);
    expect(res.status).toBe(422);
    expect(fitPdfToLimit).not.toHaveBeenCalled();
  });

  it("縮められなかったときの理由をそのまま返し、保存しない", async () => {
    const { ApiError } = await import("@/lib/api-helpers");
    fitPdfToLimit.mockRejectedValueOnce(new ApiError(422, "PDFを自動で圧縮しましたが、上限(8MB)まで小さくできませんでした", "VALIDATION_ERROR"));
    const res = await POST(await req(12 * MB, "application/pdf", "huge.pdf"), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("小さくできませんでした");
    expect(storageStub.upload).not.toHaveBeenCalled();
  });

  it("受け取る上限(50MB)を超えると申告された送信は、読む前に 413", async () => {
    const res = await POST(await req(10, "application/pdf", "x.pdf", undefined, 60 * MB), params);
    expect(res.status).toBe(413);
    expect(fitPdfToLimit).not.toHaveBeenCalled();
  });

  it("Content-Length の無い multipart は 411(ガードを回り込ませない)", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(10)], { type: "application/pdf" }), "x.pdf");
    const r = new Request("http://t/api/properties/p-1/attachments", { method: "POST", body: fd }) as unknown as NextRequest;
    const res = await POST(r, params);
    expect(res.status).toBe(411);
  });
});
