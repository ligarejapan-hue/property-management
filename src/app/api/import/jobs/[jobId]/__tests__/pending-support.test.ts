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
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
// prisma mock: Step 1 で確認した実呼び出しに合わせて調整
// (route.ts が実際に呼ぶのは importJob.findUnique / importJobRow.findMany /
//  importJobRow.groupBy / importJobRow.count のみ。findFirst は
//  job.jobType === "owner_csv" のときだけ呼ばれるが、本テストの job は
//  registry_pdf_bulk なので呼ばれない＝mock不要)。
vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn() },
    importJobRow: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PM = {
  importJob: { findUnique: Mock };
  importJobRow: { findMany: Mock; count: Mock; groupBy: Mock };
};
const pm = prisma as unknown as PM;

function call(query = "") {
  const req = new Request(`http://localhost/api/import/jobs/j1${query}`);
  return GET(req as never, { params: Promise.resolve({ jobId: "j1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
    fileName: "所有者事項PDF一括 (3件)",
    status: "processing",
    totalRows: 3,
    successCount: 1,
    errorCount: 0,
    executedBy: "u1",
    startedAt: new Date(),
    completedAt: null,
    createdAt: new Date(),
    executor: { id: "u1", name: "user" },
    rows: [],
  });
  pm.importJobRow.findMany.mockResolvedValue([]);
  pm.importJobRow.count.mockResolvedValue(2);
  pm.importJobRow.groupBy.mockResolvedValue([]);
});

describe("GET /api/import/jobs/[jobId] pending対応", () => {
  it("registry_pdf_bulk ジョブで pendingCount と isRegistryPdfBulkJob を返す", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pendingCount: number;
      isRegistryPdfBulkJob: boolean;
    };
    expect(body.pendingCount).toBe(2);
    expect(body.isRegistryPdfBulkJob).toBe(true);
  });

  it("?status=pending が拒否されない(200)", async () => {
    const res = await call("?status=pending&page=1&limit=10");
    expect(res.status).toBe(200);
  });
});
