import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn(), update: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    property: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("../process-row", () => ({
  processRegistryPdfBulkRow: vi.fn(),
}));

import prisma from "@/lib/prisma";
import { processRegistryPdfBulkRow } from "../process-row";
import {
  enqueueRegistryPdfBulkJob,
  isRegistryPdfBulkWorkerBusy,
  __resetRegistryPdfBulkWorkerForTest,
} from "../worker";

type PM = {
  importJob: { findUnique: Mock; update: Mock };
  importJobRow: { findMany: Mock };
  property: { findMany: Mock };
  user: { findUnique: Mock };
};
const pm = prisma as unknown as PM;

/** ワーカーの非同期ループが完了するまで待つ(直列・小規模なのでポーリングで十分) */
async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!isRegistryPdfBulkWorkerBusy()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("worker did not become idle");
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryPdfBulkWorkerForTest();
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
    status: "pending",
    executedBy: "u1",
  });
  pm.importJob.update.mockResolvedValue({});
  pm.user.findUnique.mockResolvedValue({ id: "u1", role: "admin" });
  pm.property.findMany.mockResolvedValue([
    { id: "p1", address: "世田谷区上馬２丁目７５２－３", realEstateNumber: null },
  ]);
});

describe("registry-pdf-bulk worker", () => {
  it("pending行を rowNumber 順に直列処理し、完了時にジョブを completed にする", async () => {
    // 1回目: pending 2行 → 処理 → 2回目(集計): success 2行
    pm.importJobRow.findMany
      .mockResolvedValueOnce([
        { id: "r1", rowNumber: 1 },
        { id: "r2", rowNumber: 2 },
      ])
      .mockResolvedValueOnce([
        { status: "success" },
        { status: "success" },
      ]);
    (processRegistryPdfBulkRow as Mock).mockResolvedValue("success");

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(processRegistryPdfBulkRow).toHaveBeenCalledTimes(2);
    expect((processRegistryPdfBulkRow as Mock).mock.calls[0][0].rowId).toBe("r1");
    expect((processRegistryPdfBulkRow as Mock).mock.calls[1][0].rowId).toBe("r2");
    // 最初に processing 化
    expect(pm.importJob.update.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        where: { id: "j1" },
        data: expect.objectContaining({ status: "processing" }),
      }),
    );
    // 最後に completed + カウンタ
    const last = pm.importJob.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe("completed");
    expect(last.data.successCount).toBe(2);
    expect(last.data.errorCount).toBe(0);
    expect(last.data.completedAt).toBeInstanceOf(Date);
  });

  it("error行があればジョブは failed・errorCountはerror+needs_review合算(既存規約)", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([{ id: "r1", rowNumber: 1 }])
      .mockResolvedValueOnce([
        { status: "success" },
        { status: "error" },
        { status: "needs_review" },
      ]);
    (processRegistryPdfBulkRow as Mock).mockResolvedValue("error");

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    const last = pm.importJob.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe("failed");
    expect(last.data.successCount).toBe(1);
    expect(last.data.errorCount).toBe(2);
  });

  it("同一jobIdの重複enqueueは1回として扱う", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([{ id: "r1", rowNumber: 1 }])
      .mockResolvedValueOnce([{ status: "success" }]);
    (processRegistryPdfBulkRow as Mock).mockResolvedValue("success");

    enqueueRegistryPdfBulkJob("j1");
    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    // findUnique(ジョブ読み)が1回だけ=1回しか処理していない
    expect(pm.importJob.findUnique).toHaveBeenCalledTimes(1);
  });

  it("registry_pdf_bulk 以外のジョブは何もしない", async () => {
    pm.importJob.findUnique.mockResolvedValue({
      id: "j1",
      jobType: "property_csv",
      status: "pending",
      executedBy: "u1",
    });
    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();
    expect(processRegistryPdfBulkRow).not.toHaveBeenCalled();
    expect(pm.importJob.update).not.toHaveBeenCalled();
  });

  it("executorユーザーが見つからなければジョブをfailedにする", async () => {
    pm.user.findUnique.mockResolvedValue(null);
    pm.importJobRow.findMany.mockResolvedValue([]);
    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();
    const last = pm.importJob.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe("failed");
  });
});
