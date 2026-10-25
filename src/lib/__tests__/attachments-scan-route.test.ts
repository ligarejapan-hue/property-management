/**
 * POST /api/properties/[id]/attachments/scan — 書類を撮る(第3段・2026-10-25)。
 *   - 撮った画像を並び順のまま PDF にまとめ、読み取った文字で種類を判別して通常の添付に入れる
 *   - 画像でないもの・枚数の範囲外は 422(PDF にする処理を呼ばない)
 *   - 書き込み権限が無ければ 403(本文を読まない)
 *   - 読み取った文字は監査にも応答にも出さない
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
const { perms } = vi.hoisted(() => ({
  perms: {
    value: [
      { resource: "property", action: "read", granted: true },
      { resource: "property", action: "write", granted: true },
    ],
  },
}));
vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(async () => ({ id: "u-admin", role: "admin" })),
    getUserPermissions: vi.fn(async () => perms.value),
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
  storageStub: { upload: vi.fn(async () => ({ url: "/uploads/scan.pdf" })), delete: vi.fn(), getUrl: vi.fn(), read: vi.fn() },
}));
vi.mock("@/lib/storage", () => ({ getStorage: () => storageStub }));
const { buildScanPdf } = vi.hoisted(() => ({ buildScanPdf: vi.fn() }));
vi.mock("@/lib/doc-scan/run", () => ({ buildScanPdf }));
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

import prisma from "@/lib/prisma";
import { POST } from "@/app/api/properties/[id]/attachments/scan/route";

const db = prisma as unknown as { attachment: { create: ReturnType<typeof vi.fn> } };
const JPEG = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n]);

async function req(pages: Buffer[]) {
  const fd = new FormData();
  pages.forEach((p, i) => fd.append("page", new Blob([new Uint8Array(p)], { type: "image/jpeg" }), `p${i}.jpg`));
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/properties/p-1/attachments/scan", {
    method: "POST", body: blob,
    headers: { "content-type": blob.type, "content-length": String(blob.size) },
  }) as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: "p-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  perms.value = [
    { resource: "property", action: "read", granted: true },
    { resource: "property", action: "write", granted: true },
  ];
  buildScanPdf.mockResolvedValue({
    ok: true, pdf: Buffer.from("%PDF-1.4 x"), text: "不動産売買契約書\n令和8年10月20日", ocrChars: 14, ocr: "done", pages: 2,
  });
});

describe("書類を撮る(POST scan)", () => {
  it("並び順のまま PDF にし、読み取った文字で種類を判別して通常の添付に入れる", async () => {
    const res = await POST(await req([JPEG(1), JPEG(2)]), params);
    expect(res.status).toBe(201);
    const pages = buildScanPdf.mock.calls[0][0] as Buffer[];
    expect(pages.map((p) => p[4])).toEqual([1, 2]);
    const d = db.attachment.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(d.type).toBe("general");
    expect(d.mimeType).toBe("application/pdf");
    expect(d.docKind).toBe("sales_contract");
    expect(d.docStage).toBe("contract");
    expect(d.docTitle).toBe("売買契約書_ハマイハイライズ305_20261020.pdf");
    const body = await res.json();
    expect(body.scan).toEqual({ pages: 2, ocr: "done", ocrChars: 14 });
  });

  it("読み取った文字は応答にも監査にも出さない", async () => {
    const res = await POST(await req([JPEG(1)]), params);
    expect(JSON.stringify(await res.json())).not.toContain("不動産売買契約書");
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain("不動産売買契約書");
  });

  it("画像でないもの(PDF など)は 422・PDF にする処理を呼ばない", async () => {
    const res = await POST(await req([Buffer.from("%PDF-1.4")]), params);
    expect(res.status).toBe(422);
    expect(buildScanPdf).not.toHaveBeenCalled();
  });

  it("0枚・31枚は 422", async () => {
    expect((await POST(await req([]), params)).status).toBe(422);
    expect((await POST(await req(Array.from({ length: 31 }, (_, i) => JPEG(i))), params)).status).toBe(422);
    expect(buildScanPdf).not.toHaveBeenCalled();
  });

  it("書き込み権限が無ければ 403", async () => {
    perms.value = [{ resource: "property", action: "read", granted: true }];
    const res = await POST(await req([JPEG(1)]), params);
    expect(res.status).toBe(403);
    expect(buildScanPdf).not.toHaveBeenCalled();
  });

  it("PDF にしているあいだに担当から外れたら、ロックの中で 403・置いたファイルを消す(@codex #594 P2)", async () => {
    const raw = (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw;
    raw.mockResolvedValueOnce([]);
    const res = await POST(await req([JPEG(1)]), params);
    expect(res.status).toBe(403);
    expect(db.attachment.create).not.toHaveBeenCalled();
    expect(storageStub.delete).toHaveBeenCalledTimes(1);
  });

  it("部品が無い環境は 503", async () => {
    buildScanPdf.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    expect((await POST(await req([JPEG(1)]), params)).status).toBe(503);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });

  it("文字が読めなくても入れる(種類はその他)", async () => {
    buildScanPdf.mockResolvedValueOnce({ ok: true, pdf: Buffer.from("%PDF-1.4"), text: "", ocrChars: 0, ocr: "done", pages: 1 });
    const res = await POST(await req([JPEG(1)]), params);
    expect(res.status).toBe(201);
    expect((db.attachment.create.mock.calls[0][0].data as Record<string, unknown>).docKind).toBeNull();
  });
});
