/**
 * POST /api/properties/[id]/attachments — 入れるときに取引を選ぶ(2026-11-04 案A)。
 *   - dealScope=取引の id → その取引・"common" → 共通・無し → 未区分(列を書かない)
 *   - この物件の取引だけ(ロックの中で確かめる)・取引を見る権限が無ければ 403
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  return { NextRequest: MockNextRequest };
});
const { permsState } = vi.hoisted(() => ({ permsState: { dealRead: true } }));
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
      ...(permsState.dealRead ? [{ resource: "deal", action: "read", granted: true }] : []),
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
vi.mock("@/lib/pdf-compress/fit", () => ({
  fitPdfToLimit: vi.fn(async (buf: Buffer) => ({ buffer: buf, originalSize: null, level: null })),
  reserveLargePdfSlot: vi.fn(() => () => {}),
}));
vi.mock("@/lib/pdf-extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf-extract")>();
  return { ...actual, extractHeadTextFromPdf: vi.fn(async () => "") };
});
vi.mock("@/lib/registry-pdf/fill-areas", () => ({
  fillBasicInfoFromRegistryPdfBestEffort: vi.fn(async () => ({ filled: [], skippedByEditLock: false })),
}));
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    property: {
      findUnique: vi.fn(async () => ({ id: "p-1", createdBy: "u-admin", assignedTo: null, buildingName: null, roomNo: null, address: "東京都…" })),
    },
    attachment: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "a-1", ...data })),
    },
    deal: { findFirst: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw = vi.fn(async () => [{ id: "p-1" }]);
  return { default: db };
});

import prisma from "@/lib/prisma";
import { POST } from "@/app/api/properties/[id]/attachments/route";

const db = prisma as unknown as {
  attachment: { create: ReturnType<typeof vi.fn> };
  deal: { findFirst: ReturnType<typeof vi.fn> };
};
const D1 = "33333333-3333-4333-8333-333333333333";

async function req(dealScope?: string) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(Buffer.from("%PDF-1.4\n%fake\n"))], { type: "application/pdf" }), "売買契約書.pdf");
  if (dealScope !== undefined) fd.append("dealScope", dealScope);
  const blob = await new Response(fd).blob();
  return new Request("http://t/api/properties/p-1/attachments", {
    method: "POST", body: blob,
    headers: { "content-type": blob.type, "content-length": String(blob.size) },
  }) as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: "p-1" }) };
const created = () => db.attachment.create.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  permsState.dealRead = true;
  db.deal.findFirst.mockResolvedValue({ id: D1 });
});

describe("入れるときの取引(POST)", () => {
  it("取引を選ぶとその取引・この物件の取引かを確かめる", async () => {
    const res = await POST(await req(D1), params);
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({ dealId: D1, dealCommon: false });
    expect(db.deal.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: D1, propertyId: "p-1" } });
  });
  it("共通を選ぶと共通", async () => {
    await POST(await req("common"), params);
    expect(created()).toMatchObject({ dealId: null, dealCommon: true });
    expect(db.deal.findFirst).not.toHaveBeenCalled();
  });
  it("選ばなければ未区分(列を書かない)", async () => {
    await POST(await req(), params);
    expect("dealId" in created()).toBe(false);
    expect("dealCommon" in created()).toBe(false);
  });
  it("ほかの物件の取引は 422・読めない指定も 422(作らない・保存先にも置かない)", async () => {
    db.deal.findFirst.mockResolvedValue(null);
    expect((await POST(await req(D1), params)).status).toBe(422);
    expect((await POST(await req("xyz"), params)).status).toBe(422);
    expect(db.attachment.create).not.toHaveBeenCalled();
    expect(storageStub.upload).not.toHaveBeenCalled();
  });
  it("取引を見る権限が無い人が取引を選ぶと 403(作らない)", async () => {
    permsState.dealRead = false;
    expect((await POST(await req("common"), params)).status).toBe(403);
    expect(db.attachment.create).not.toHaveBeenCalled();
  });
});
