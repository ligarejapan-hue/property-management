import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// registry_pdf_bulk 行は専用の手動添付API(manual-attach-registry-pdf)を使う運用のため、
// 汎用行解決PATCH(link_existing)がこの種別の行を誤って直接紐付けしないことを検証する
// (create_new 側の既存ジョブタイプガードと同じ形式)。

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
vi.mock("@/lib/owner-dedup", () => ({ findDuplicateOwner: vi.fn() }));
vi.mock("@/lib/import-job-counts", () => ({
  recalculateJobCounts: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    importJobRow: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    property: { findUnique: vi.fn(), create: vi.fn() },
    owner: { findUnique: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: vi.fn() };
});

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { PATCH } from "../route";

type PM = {
  importJobRow: { findUnique: Mock; update: Mock };
  property: { findUnique: Mock; create: Mock };
  owner: { findUnique: Mock; create: Mock };
};
const pm = prisma as unknown as PM;

const storageMock = { read: vi.fn(), upload: vi.fn(), delete: vi.fn() };

function call(body: unknown, jobId = "j1", rowId = "r1") {
  const req = new Request("http://localhost/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req as never, { params: Promise.resolve({ jobId, rowId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  (getStorage as Mock).mockReturnValue(storageMock);
  storageMock.delete.mockResolvedValue(undefined);
  pm.importJobRow.update.mockResolvedValue({});
});

describe("PATCH .../rows/[rowId] (汎用行解決)", () => {
  it("registry_pdf_bulk 行への link_existing は 422", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      rawData: {},
      job: { id: "j1", jobType: "registry_pdf_bulk" },
    });
    const res = await call({ action: "link_existing", targetId: "p9" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(pm.property.findUnique).not.toHaveBeenCalled();
    expect(pm.importJobRow.update).not.toHaveBeenCalled();
  });

  it("registry_pdf_bulk 行でも skip は許可される(変更なし)", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      rawData: {},
      job: { id: "j1", jobType: "registry_pdf_bulk" },
    });
    const res = await call({ action: "skip" });
    expect(res.status).toBe(200);
  });

  it("registry_pdf_bulk 行の skip 確定後、staging(所有者PII)をbest-effortで削除する", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      rawData: { stagedKey: "import-staging/registry-pdf/j1/1.pdf" },
      job: { id: "j1", jobType: "registry_pdf_bulk" },
    });
    const res = await call({ action: "skip" });
    expect(res.status).toBe(200);
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/1.pdf",
    );
  });

  it("registry_pdf_bulk 行の mark_error 確定後、staging をbest-effortで削除する", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "error",
      rawData: { stagedKey: "import-staging/registry-pdf/j1/2.pdf" },
      job: { id: "j1", jobType: "registry_pdf_bulk" },
    });
    const res = await call({ action: "mark_error" });
    expect(res.status).toBe(200);
    expect(storageMock.delete).toHaveBeenCalledWith(
      "import-staging/registry-pdf/j1/2.pdf",
    );
  });

  it("registry_pdf_bulk 以外(owner_csv)の skip は staging 削除を試みない", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      rawData: { stagedKey: "should-not-be-used" },
      job: { id: "j1", jobType: "owner_csv" },
    });
    const res = await call({ action: "skip" });
    expect(res.status).toBe(200);
    expect(storageMock.delete).not.toHaveBeenCalled();
  });

  it("stagedKeyが文字列でない場合は削除を試みない", async () => {
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 1,
      status: "needs_review",
      rawData: {},
      job: { id: "j1", jobType: "registry_pdf_bulk" },
    });
    const res = await call({ action: "skip" });
    expect(res.status).toBe(200);
    expect(storageMock.delete).not.toHaveBeenCalled();
  });
});
