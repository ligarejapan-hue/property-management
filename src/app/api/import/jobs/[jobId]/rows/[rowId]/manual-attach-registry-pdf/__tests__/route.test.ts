import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  getApiSession: vi.fn(),
  getUserPermissions: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: vi.fn(() => true) }));
vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(() => true),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    importJob: { update: vi.fn() },
    property: { findUnique: vi.fn() },
    attachment: { create: vi.fn() },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: vi.fn() };
});

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { POST } from "../route";

type PM = {
  importJobRow: {
    findUnique: Mock;
    updateMany: Mock;
    update: Mock;
    findMany: Mock;
  };
  importJob: { update: Mock };
  property: { findUnique: Mock };
  attachment: { create: Mock };
};
const pm = prisma as unknown as PM;

const PDF_BUF = Buffer.from("%PDF-1.4 test");
const storageMock = { read: vi.fn(), upload: vi.fn(), delete: vi.fn() };

function call(body: unknown, jobId = "j1", rowId = "r1") {
  const req = new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as never, { params: Promise.resolve({ jobId, rowId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (canAccessPropertyRecord as Mock).mockReturnValue(true);
  (getStorage as Mock).mockReturnValue(storageMock);
  pm.importJobRow.findUnique.mockResolvedValue({
    id: "r1",
    jobId: "j1",
    rowNumber: 1,
    status: "needs_review",
    createdId: null,
    rawData: {
      fileName: "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
      stagedKey: "import-staging/registry-pdf/j1/1.pdf",
      requestNumber: "2024121200118150",
      location: "世田谷区上馬２丁目７５２－３",
    },
    job: { id: "j1", jobType: "registry_pdf_bulk" },
  });
  pm.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm.importJobRow.update.mockResolvedValue({});
  pm.importJobRow.findMany.mockResolvedValue([
    { status: "success" },
    { status: "needs_review" },
  ]);
  pm.importJob.update.mockResolvedValue({});
  pm.property.findUnique.mockResolvedValue({ createdBy: "u1", assignedTo: null });
  pm.attachment.create.mockResolvedValue({ id: "att1" });
  storageMock.read.mockResolvedValue({
    body: PDF_BUF,
    contentType: "application/pdf",
    size: PDF_BUF.length,
  });
  storageMock.upload.mockResolvedValue({
    url: "/uploads/properties/p9/registry/x.pdf",
    key: "properties/p9/registry/x.pdf",
  });
  storageMock.delete.mockResolvedValue(undefined);
});

describe("POST .../manual-attach-registry-pdf", () => {
  it("指定物件に添付し、行をsuccessに確定・staging削除・カウンタ再計算", async () => {
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; attachmentId: string };
    expect(body.ok).toBe(true);
    expect(body.attachmentId).toBe("att1");
    // atomic claim
    expect(pm.importJobRow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "r1",
          status: "needs_review",
          createdId: null,
        }),
      }),
    );
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          propertyId: "p9",
          type: "registry",
          uploadedBy: "u1",
        }),
        select: { id: true },
      }),
    );
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
    expect(pm.importJob.update).toHaveBeenCalled();
  });

  it("propertyId 未指定は 422", async () => {
    const res = await call({});
    expect(res.status).toBe(422);
  });

  it("claim競合(count=0)は 409", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(409);
  });

  it("種別違いのジョブは 422", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      createdId: null,
      rawData: {},
      job: { id: "j1", jobType: "owner_csv" },
    });
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(422);
  });

  it("stagedファイル消失は 422 でclaimを戻す", async () => {
    storageMock.read.mockResolvedValue(null);
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(422);
    // claim復帰(createdId を null に戻す)
    const revert = pm.importJobRow.updateMany.mock.calls.at(-1)![0];
    expect(revert.data.createdId).toBeNull();
  });

  it("アクセス権なしの物件は 403", async () => {
    (canAccessPropertyRecord as Mock).mockReturnValue(false);
    const res = await call({ propertyId: "p9" });
    expect(res.status).toBe(403);
  });
});
