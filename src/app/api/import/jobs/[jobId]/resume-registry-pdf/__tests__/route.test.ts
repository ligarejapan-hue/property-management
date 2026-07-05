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
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: { count: vi.fn() },
  },
}));
vi.mock("@/lib/registry-pdf-bulk/worker", () => ({
  enqueueRegistryPdfBulkJob: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { enqueueRegistryPdfBulkJob } from "@/lib/registry-pdf-bulk/worker";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../route";

type PM = {
  importJob: { findUnique: Mock };
  importJobRow: { count: Mock };
};
const pm = prisma as unknown as PM;

function jobFixture(status: string) {
  return { id: "j1", jobType: "registry_pdf_bulk", status };
}

function call(jobId = "j1") {
  return POST({} as never, { params: Promise.resolve({ jobId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJob.findUnique.mockResolvedValue(jobFixture("processing"));
  pm.importJobRow.count.mockResolvedValue(3);
});

describe("POST /api/import/jobs/[jobId]/resume-registry-pdf", () => {
  it("pending行があればenqueueして件数を返す", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pendingCount: 3 });
    expect(enqueueRegistryPdfBulkJob).toHaveBeenCalledWith("j1");
  });

  it("pending行があれば監査ログを書き込む", async () => {
    await call();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        action: "registry_pdf_bulk_resume",
        targetTable: "import_jobs",
        targetId: "j1",
        detail: { pendingCount: 3 },
      }),
    );
  });

  it("pending行が0でもジョブがprocessingならenqueueする(集計確定リカバリ)", async () => {
    pm.importJobRow.count.mockResolvedValue(0);
    pm.importJob.findUnique.mockResolvedValue(jobFixture("processing"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pendingCount: 0 });
    expect(enqueueRegistryPdfBulkJob).toHaveBeenCalledWith("j1");
  });

  it("pending行が0でもジョブがprocessingなら監査ログを書き込む(集計確定リカバリ)", async () => {
    pm.importJobRow.count.mockResolvedValue(0);
    pm.importJob.findUnique.mockResolvedValue(jobFixture("processing"));
    await call();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        action: "registry_pdf_bulk_resume",
        targetTable: "import_jobs",
        targetId: "j1",
        detail: { pendingCount: 0 },
      }),
    );
  });

  it("pending行が0でジョブが終端(completed)ならenqueueしない", async () => {
    pm.importJobRow.count.mockResolvedValue(0);
    pm.importJob.findUnique.mockResolvedValue(jobFixture("completed"));
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pendingCount: 0 });
    expect(enqueueRegistryPdfBulkJob).not.toHaveBeenCalled();
  });

  it("pending行が0でジョブが終端(completed)なら監査ログを書き込まない", async () => {
    pm.importJobRow.count.mockResolvedValue(0);
    pm.importJob.findUnique.mockResolvedValue(jobFixture("completed"));
    await call();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("ジョブが無ければ404", async () => {
    pm.importJob.findUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it("registry_pdf_bulk 以外は422", async () => {
    pm.importJob.findUnique.mockResolvedValue({
      id: "j1",
      jobType: "property_csv",
    });
    const res = await call();
    expect(res.status).toBe(422);
  });
});
