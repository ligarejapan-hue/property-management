/**
 * POST /api/properties/[id]/attachments — 書類の自動判別(2026-10-23)。
 *   - 通常添付は名前(と PDF の本文)から段階・種類・そろえた名前が付く
 *   - 本文の抽出が落ちても 201(判別は名前だけで続ける)
 *   - 謄本(registry)には4列を付けない
 *   - 当たらなければ4列とも入れない(=null・元の名前のまま)
 *   - 同じ名前が既にあれば連番
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

import prisma from "@/lib/prisma";
import { POST } from "@/app/api/properties/[id]/attachments/route";

const db = prisma as unknown as { attachment: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> } };
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
const created = () => db.attachment.create.mock.calls[0][0].data as Record<string, unknown>;
const today = () => {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, "0")}${String(n.getDate()).padStart(2, "0")}`;
};

beforeEach(() => {
  vi.clearAllMocks();
  extractTextFromPdf.mockResolvedValue("");
  db.attachment.findMany.mockResolvedValue([]);
});

describe("添付の自動判別(POST)", () => {
  it("名前で当たる PDF → 段階・種類・そろえた名前・high", async () => {
    const res = await POST(await req("【完成版】売買契約書.pdf", "application/pdf"), params);
    expect(res.status).toBe(201);
    const d = created();
    expect(d.docStage).toBe("contract");
    expect(d.docKind).toBe("sales_contract");
    expect(d.docTitle).toBe(`売買契約書_ハマイハイライズ305_${today()}.pdf`);
    expect(d.docConfidence).toBe("high");
    expect(d.fileName).toBe("【完成版】売買契約書.pdf");
  });

  it("名前で当たらず本文の見出しで当たる → high・本文の日付を名前に", async () => {
    extractTextFromPdf.mockResolvedValueOnce("付帯設備表\n\n令和8年9月30日");
    await POST(await req("scan001.pdf", "application/pdf"), params);
    const d = created();
    expect(d.docKind).toBe("fixtures_list");
    expect(d.docTitle).toBe("付帯設備表_ハマイハイライズ305_20260930.pdf");
    expect(extractTextFromPdf).toHaveBeenCalledTimes(1);
  });

  it("本文の抽出が落ちても 201(名前だけで判別)", async () => {
    extractTextFromPdf.mockRejectedValueOnce(new Error("broken pdf"));
    const res = await POST(await req("重要事項説明書.pdf", "application/pdf"), params);
    expect(res.status).toBe(201);
    expect(created().docKind).toBe("disclosure");
  });

  it("当たらなければ4列を入れない", async () => {
    const res = await POST(await req("資料.pdf", "application/pdf"), params);
    expect(res.status).toBe(201);
    const d = created();
    expect(d.docStage).toBeNull();
    expect(d.docKind).toBeNull();
    expect(d.docTitle).toBeNull();
    expect(d.docConfidence).toBeNull();
  });

  it("謄本(registry)は本文を読まず、4列を付けない", async () => {
    await POST(await req("売買契約書.pdf", "application/pdf", "registry"), params);
    const d = created();
    expect(extractTextFromPdf).not.toHaveBeenCalled();
    expect("docKind" in d).toBe(false);
    expect(db.attachment.findMany).not.toHaveBeenCalled();
  });

  it("画像は名前だけで判別(本文は読まない)", async () => {
    await POST(await req("運転免許証.png", "image/png", undefined, Buffer.from("\x89PNG....")), params);
    expect(extractTextFromPdf).not.toHaveBeenCalled();
    expect(created().docKind).toBe("identity_document");
  });

  it("同じ名前が既にあれば連番(ロックの中で既存の名前を読む)", async () => {
    db.attachment.findMany.mockResolvedValueOnce([{ docTitle: `売買契約書_ハマイハイライズ305_${today()}.pdf` }]);
    await POST(await req("売買契約書.pdf", "application/pdf"), params);
    expect(created().docTitle).toBe(`売買契約書_ハマイハイライズ305_${today()}_2.pdf`);
    const where = db.attachment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ targetType: "property", targetId: "p-1", isDeleted: false });
  });
});
