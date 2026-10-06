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
const applyBuildingLinkMock = vi.fn();
const writeBuildingLinkAuditMock = vi.fn();
vi.mock("@/lib/building-link/apply", () => ({
  applyBuildingLink: (...a: unknown[]) => applyBuildingLinkMock(...a),
  writeBuildingLinkAudit: (...a: unknown[]) => writeBuildingLinkAuditMock(...a),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    $transaction: vi.fn(),
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
import { POST as RETRY } from "../retry/route";

type PM = {
  $transaction: Mock;
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
  // 物件の作成と棟へのつなぎは同じトランザクション(tx は prisma の偽物をそのまま渡す)。
  pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(pm));
  applyBuildingLinkMock.mockResolvedValue({
    action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [],
  });
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

  it("要確認で選んだ棟(__resolved_building_id)で create_new すると、apply に existing が渡る(同じトランザクション)", async () => {
    const BID = "11111111-2222-4333-8444-555555555555";
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 3,
      status: "needs_review",
      rawData: { "住所": "東京都大田区南雪谷1丁目1-1", "マンション名": "パーク第一" },
      job: { id: "j1", jobType: "property_csv" },
    });
    pm.property.create.mockResolvedValue({
      id: "p1",
      propertyType: "apartment_unit",
      buildingName: "パーク第一",
      address: "東京都大田区南雪谷1丁目1-1",
      buildingNumber: null,
    });
    const outcome = {
      action: "linked", building: { id: BID, name: "パーク第一" }, previousBuildingId: null, renamedFrom: null, warnings: [],
    };
    applyBuildingLinkMock.mockResolvedValue(outcome);
    const res = await call({
      action: "create_new",
      editedData: {
        "住所": "東京都大田区南雪谷1丁目1-1",
        "マンション名": "パーク第一",
        __resolved_building_id: BID.toUpperCase(),
      },
    });
    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(pm.property.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ propertyType: "apartment_unit", buildingName: "パーク第一" }),
    });
    expect(applyBuildingLinkMock).toHaveBeenCalledWith(
      pm,
      expect.objectContaining({
        propertyId: "p1",
        choice: { kind: "existing", buildingId: BID },
        currentBuildingId: null,
        userId: "u1",
        // 取込が作った棟の目印を同じ tx で書くため(取り消しで空の棟を消す)。
        importJobId: "j1",
      }),
    );
    expect(writeBuildingLinkAuditMock).toHaveBeenCalledWith("u1", "p1", outcome, { importJobId: "j1" });
    expect(pm.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "success", createdId: "p1" }) }),
    );
  });

  it("retry でも、選んだ棟(__resolved_building_id)が apply に existing で渡る", async () => {
    const BID = "11111111-2222-4333-8444-555555555555";
    pm.importJobRow.findUnique.mockResolvedValue({
      id: "r1",
      jobId: "j1",
      rowNumber: 4,
      status: "error",
      rawData: { "住所": "東京都大田区南雪谷1丁目1-2", "棟名": "パーク第一", __resolved_building_id: BID },
      job: { id: "j1", jobType: "property_csv" },
    });
    pm.property.create.mockResolvedValue({
      id: "p2", propertyType: "apartment_unit", buildingName: "パーク第一",
      address: "東京都大田区南雪谷1丁目1-2", buildingNumber: null,
    });
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await RETRY(req as never, { params: Promise.resolve({ jobId: "j1", rowId: "r1" }) });
    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(applyBuildingLinkMock).toHaveBeenCalledWith(
      pm,
      expect.objectContaining({ propertyId: "p2", choice: { kind: "existing", buildingId: BID }, importJobId: "j1" }),
    );
    expect(writeBuildingLinkAuditMock).toHaveBeenCalledTimes(1);
  });
});
