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
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { create: vi.fn() },
    importJobRow: { createMany: vi.fn() },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: vi.fn() };
});
vi.mock("@/lib/registry-pdf-bulk/worker", () => ({
  enqueueRegistryPdfBulkJob: vi.fn(),
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";
import { POST } from "../route";

type PM = {
  importJob: { create: Mock };
  importJobRow: { createMany: Mock };
};
const pm = prisma as unknown as PM;

const storageMock = { upload: vi.fn(), delete: vi.fn() };

function pdfFile(name: string, size = 1024): File {
  const body = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(Math.max(0, size - 9), 0x20),
  ]);
  return new File([body], name, { type: "application/pdf" });
}

function textFile(name: string): File {
  return new File([Buffer.from("not a pdf")], name, { type: "text/plain" });
}

function makeRequest(files: File[]): Request {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  return new Request("http://localhost/api/import/registry-pdf-bulk", {
    method: "POST",
    body: fd,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (hasPermission as Mock).mockReturnValue(true);
  (getStorage as Mock).mockReturnValue(storageMock);
  storageMock.upload.mockResolvedValue({ url: "/uploads/x", key: "x" });
  pm.importJob.create.mockResolvedValue({ id: "11111111-2222-3333-4444-555555555555" });
  pm.importJobRow.createMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/import/registry-pdf-bulk", () => {
  it("PDFを受け付けてジョブ+pending行を作り、ワーカーにenqueueして202", async () => {
    const res = await POST(
      makeRequest([
        pdfFile(
          "世田谷区上馬２丁目７５２－３不動産登記（建物所有者事項）2024121200118150.PDF",
        ),
      ]) as never,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      jobId: string;
      totalRows: number;
      acceptedCount: number;
      rejectedCount: number;
    };
    expect(body.totalRows).toBe(1);
    expect(body.acceptedCount).toBe(1);
    expect(body.rejectedCount).toBe(0);
    expect(pm.importJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobType: "registry_pdf_bulk",
          status: "pending",
          totalRows: 1,
          executedBy: "u1",
        }),
      }),
    );
    const rows = pm.importJobRow.createMany.mock.calls[0][0].data as Array<{
      status: string;
      rawData: Record<string, string>;
    }>;
    expect(rows[0].status).toBe("pending");
    expect(rows[0].rawData.requestNumber).toBe("2024121200118150");
    expect(rows[0].rawData.location).toBe("世田谷区上馬２丁目７５２－３");
    expect(rows[0].rawData.stagedKey).toContain("import-staging/registry-pdf/");
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
    expect(enqueueRegistryPdfBulkJob).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("非PDFは当該ファイルのみ error 行として記録(全体は202)", async () => {
    const res = await POST(
      makeRequest([
        pdfFile(
          "世田谷区弦巻１丁目３２－３１不動産登記（土地所有者事項）2024121100710215.pdf",
        ),
        textFile("メモ.txt"),
      ]) as never,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { acceptedCount: number; rejectedCount: number };
    expect(body.acceptedCount).toBe(1);
    expect(body.rejectedCount).toBe(1);
    const rows = pm.importJobRow.createMany.mock.calls[0][0].data as Array<{
      status: string;
    }>;
    expect(rows.filter((r) => r.status === "error")).toHaveLength(1);
    // 非PDFはstagingに保存しない
    expect(storageMock.upload).toHaveBeenCalledTimes(1);
  });

  it("ファイル0件は 400 NO_FILE", async () => {
    const res = await POST(makeRequest([]) as never);
    expect(res.status).toBe(400);
  });

  it("100件超は 422 TOO_MANY_FILES", async () => {
    const files = Array.from({ length: 101 }, (_, i) =>
      pdfFile(`世田谷区上馬２丁目７５２－${i}不動産登記（建物所有者事項）20241212001181${String(i).padStart(2, "0")}.pdf`),
    );
    const res = await POST(makeRequest(files) as never);
    expect(res.status).toBe(422);
    expect(pm.importJob.create).not.toHaveBeenCalled();
  });

  it("権限なしは 403", async () => {
    (hasPermission as Mock).mockReturnValue(false);
    const res = await POST(makeRequest([pdfFile("a.pdf")]) as never);
    expect(res.status).toBe(403);
  });

  it("Content-Length が上限超過なら 413(formDataを読む前)", async () => {
    // 実Requestは undici が content-length を管理するため、route が使う
    // インターフェース(headers.get / formData)だけ持つ stub を渡す
    const formDataSpy = vi.fn();
    const req = {
      headers: new Headers({ "content-length": String(200 * 1024 * 1024) }),
      formData: formDataSpy,
    };
    const res = await POST(req as never);
    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
