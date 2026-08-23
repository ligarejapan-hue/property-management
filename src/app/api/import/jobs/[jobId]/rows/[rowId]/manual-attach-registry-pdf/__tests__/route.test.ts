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
    attachment: { create: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
    // #402: 添付作成 tx の親行ロック(lockPropertyRow)の実体。
    $queryRaw: vi.fn(async () => [{ id: "p" }]),
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
  attachment: { create: Mock; delete: Mock };
  $transaction: Mock;
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
  // 確定(claim)は最後の $transaction 内で1回だけ呼ばれる想定。既定はcount:1(成功)。
  pm.importJobRow.updateMany.mockResolvedValue({ count: 1 });
  pm.importJobRow.update.mockResolvedValue({});
  pm.importJobRow.findMany.mockResolvedValue([
    { status: "success" },
    { status: "needs_review" },
  ]);
  pm.importJob.update.mockResolvedValue({});
  pm.property.findUnique.mockResolvedValue({ createdBy: "u1", assignedTo: null });
  pm.attachment.create.mockResolvedValue({ id: "att1" });
  pm.attachment.delete.mockResolvedValue({});
  // $transaction(fn) は同一 prisma mock を tx として渡す。既存の
  // pm.importJobRow.updateMany(確定claim) / findMany / pm.importJob.update への
  // アサーションはそのまま tx 経由呼び出しとして検証できる。
  pm.$transaction.mockImplementation(
    async (fn: (tx: typeof pm) => unknown) => fn(pm),
  );
  storageMock.read.mockResolvedValue({
    body: PDF_BUF,
    contentType: "application/pdf",
    size: PDF_BUF.length,
  });
  storageMock.upload.mockResolvedValue({
    url: "/uploads/properties/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/registry/x.pdf",
    key: "properties/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/registry/x.pdf",
  });
  storageMock.delete.mockResolvedValue(undefined);
});

describe("POST .../manual-attach-registry-pdf", () => {
  it("指定物件に添付し、行をsuccessに確定・staging削除・カウンタ再計算", async () => {
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; attachmentId: string };
    expect(body.ok).toBe(true);
    expect(body.attachmentId).toBe("att1");
    // 確定(claim)は最後の1回のみ: where=needs_review+createdId null,
    // data=success/手動添付/createdId=propertyId
    expect(pm.importJobRow.updateMany).toHaveBeenCalledTimes(1);
    expect(pm.importJobRow.updateMany).toHaveBeenCalledWith({
      where: {
        id: "r1",
        jobId: "j1",
        status: "needs_review",
        createdId: null,
      },
      data: {
        status: "success",
        errorMessage: "手動添付",
        createdId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });
    expect(pm.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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

  it("propertyId がUUID形式でない場合は422(DBに問い合わせない)", async () => {
    const res = await call({ propertyId: "not-a-uuid" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(pm.property.findUnique).not.toHaveBeenCalled();
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
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(422);
  });

  it("stagedファイル消失は 422(claimは一切行われない=行は無傷のまま再試行可能)", async () => {
    storageMock.read.mockResolvedValue(null);
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(422);
    // 確定(claim)は storage/attachment 作成が終わった後にしか行わないため、
    // storage.read の時点で失敗する本ケースでは一度も呼ばれない。
    expect(pm.importJobRow.updateMany).not.toHaveBeenCalled();
  });

  it("アクセス権なしの物件は 403", async () => {
    (canAccessPropertyRecord as Mock).mockReturnValue(false);
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(403);
  });

  it("claim競合(count=0)は 409 で添付をundo(claimは未成立=行はそのまま)", async () => {
    pm.importJobRow.updateMany.mockResolvedValue({ count: 0 });
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(409);
    // undo: 作成済みの添付レコードとアップロード済みblobを取り消す
    expect(pm.attachment.delete).toHaveBeenCalledWith({ where: { id: "att1" } });
    expect(storageMock.delete).toHaveBeenCalledWith(
      "properties/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/registry/x.pdf",
    );
    // stagingは行が確定していないので削除しない
    expect(storageMock.delete).not.toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });

  it("確定(claim)がDB例外で失敗しても500・添付undo・stagedKeyは温存", async () => {
    pm.importJobRow.updateMany.mockRejectedValueOnce(new Error("db down"));
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(500);
    expect(pm.attachment.delete).toHaveBeenCalledWith({
      where: { id: "att1" },
    });
    expect(storageMock.delete).toHaveBeenCalledWith(
      "properties/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/registry/x.pdf",
    );
    expect(storageMock.delete).not.toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
    // claim例外でtxは中断しているため、カウンタ更新まで到達しない
    expect(pm.importJob.update).not.toHaveBeenCalled();
  });

  it("カウンタ更新(tx内)失敗でも添付undo(500)・stagedKeyは温存", async () => {
    // 実DBでは interactive $transaction が例外時にtx全体(claimの更新含む)を
    // ロールバックするため、catch到達時は常に「行=needs_review + claim無し」=
    // 添付undoのみで整合する(claim自体のrevertは不要)。このmockでは
    // $transaction を `fn(pm)` で代替しており実ロールバックは再現できないため、
    // ここではtx内の後段(カウンタ更新)がrejectすることのみ検証する。
    pm.importJob.update.mockRejectedValueOnce(new Error("db down"));
    const res = await call({ propertyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(res.status).toBe(500);
    expect(pm.attachment.delete).toHaveBeenCalledWith({
      where: { id: "att1" },
    });
    expect(storageMock.delete).toHaveBeenCalledWith(
      "properties/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/registry/x.pdf",
    );
    expect(storageMock.delete).not.toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });
});
