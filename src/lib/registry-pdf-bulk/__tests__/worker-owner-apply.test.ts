/**
 * ワーカーの振り分け。「所有者事項PDF一括」の取込記録には2種類の行が入りうる:
 *   - PDFを上げた一括取込の行（従来）
 *   - 「謄本から所有者をまとめて反映」の行（印つき・今回追加）
 *
 * ⚠**待機列とワーカーは1本のまま**にする(同時に走る処理を常に1つに保つ)。
 *   別のワーカーを足すと、2つのジョブが同時にサーバーへ負荷をかける。
 * ⚠まとめて反映の行があるジョブは、**処理を始める前に実行者の権限をもう一度確かめる**
 *   (受け付けたあとに権限を外された場合、1,821行ぶんの失敗を作らない)。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn(), update: vi.fn() },
    importJobRow: { findMany: vi.fn() },
    property: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("../process-row", () => ({ processRegistryPdfBulkRow: vi.fn() }));
vi.mock("@/lib/registry-owner-bulk/process-row", () => ({
  processRegistryOwnerApplyRow: vi.fn(),
}));
vi.mock("@/lib/api-helpers", () => ({ getUserPermissions: vi.fn() }));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { processRegistryPdfBulkRow } from "../process-row";
import { processRegistryOwnerApplyRow } from "@/lib/registry-owner-bulk/process-row";
import { buildRegistryOwnerApplyRawData } from "@/lib/registry-owner-bulk/marker";
import {
  enqueueRegistryPdfBulkJob,
  isRegistryPdfBulkWorkerBusy,
  __resetRegistryPdfBulkWorkerForTest,
} from "../worker";

const pm = prisma as unknown as {
  importJob: { findUnique: Mock; update: Mock };
  importJobRow: { findMany: Mock };
  property: { findMany: Mock };
  user: { findUnique: Mock };
};

const ALL_PERMS = [
  { resource: "property", action: "read", granted: true },
  { resource: "registry_pdf", action: "preview", granted: true },
  { resource: "import", action: "write", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "edit", granted: true },
  { resource: "owner_address", action: "edit", granted: true },
];

const ownerApplyRow = (id: string, rowNumber: number) => ({
  id,
  rowNumber,
  rawData: buildRegistryOwnerApplyRawData({
    propertyId: `1111111${rowNumber}-1111-4111-8111-111111111111`,
    address: null,
  }),
});

async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!isRegistryPdfBulkWorkerBusy()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("worker did not become idle");
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠clearAllMocks は mockResolvedValueOnce の積み残しを消さない。途中で止まるテストの
  //   残りが次のテストの1回目に流れ込み、「1行も処理しない」系が偶然通っていた。
  pm.importJobRow.findMany.mockReset();
  __resetRegistryPdfBulkWorkerForTest();
  pm.importJob.findUnique.mockResolvedValue({
    id: "j1",
    jobType: "registry_pdf_bulk",
    status: "pending",
    executedBy: "u1",
  });
  pm.importJob.update.mockResolvedValue({});
  pm.user.findUnique.mockResolvedValue({ id: "u1", role: "admin", isActive: true });
  pm.property.findMany.mockResolvedValue([]);
  (getUserPermissions as unknown as Mock).mockResolvedValue(ALL_PERMS);
  (processRegistryOwnerApplyRow as Mock).mockResolvedValue("success");
  (processRegistryPdfBulkRow as Mock).mockResolvedValue("success");
});

describe("まとめて反映の行の振り分け", () => {
  it("印のある行はまとめて反映の処理へ、それ以外は従来の処理へ渡す", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([
        ownerApplyRow("r1", 1),
        { id: "r2", rowNumber: 2, rawData: { fileName: "x.PDF", stagedKey: "staging/x.pdf" } },
      ])
      .mockResolvedValueOnce([{ status: "success" }, { status: "success" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect((processRegistryOwnerApplyRow as Mock).mock.calls).toHaveLength(1);
    expect((processRegistryOwnerApplyRow as Mock).mock.calls[0][0]).toMatchObject({
      jobId: "j1",
      rowId: "r1",
      executor: { id: "u1", role: "admin" },
      perms: ALL_PERMS,
    });
    expect((processRegistryPdfBulkRow as Mock).mock.calls).toHaveLength(1);
    expect((processRegistryPdfBulkRow as Mock).mock.calls[0][0]).toMatchObject({ rowId: "r2" });
  });

  it("⚠まとめて反映だけのジョブでは、物件の全件読み込みをしない（重い処理を増やさない）", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([ownerApplyRow("r1", 1), ownerApplyRow("r2", 2)])
      .mockResolvedValueOnce([{ status: "success" }, { status: "success" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect((processRegistryOwnerApplyRow as Mock).mock.calls).toHaveLength(2);
  });

  it("⚠権限を外された実行者のジョブは、1行も処理せず失敗にする", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(
      ALL_PERMS.filter((p) => p.resource !== "owner"),
    );
    pm.importJobRow.findMany
      .mockResolvedValueOnce([ownerApplyRow("r1", 1)])
      .mockResolvedValueOnce([{ status: "pending" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(processRegistryOwnerApplyRow).not.toHaveBeenCalled();
    const statuses = pm.importJob.update.mock.calls.map(
      (c) => (c[0].data as { status?: string }).status,
    );
    expect(statuses).toContain("failed");
  });

  it("⚠謄本の閲覧を止められた実行者のジョブは、1行も処理しない", async () => {
    (getUserPermissions as unknown as Mock).mockResolvedValue(
      ALL_PERMS.filter((p) => p.resource !== "registry_pdf"),
    );
    pm.importJobRow.findMany
      .mockResolvedValueOnce([ownerApplyRow("r1", 1)])
      .mockResolvedValueOnce([{ status: "pending" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(processRegistryOwnerApplyRow).not.toHaveBeenCalled();
  });

  it("⚠管理者でなくなった実行者のジョブも、1行も処理しない", async () => {
    pm.user.findUnique.mockResolvedValue({ id: "u1", role: "office_staff", isActive: true });
    pm.importJobRow.findMany
      .mockResolvedValueOnce([ownerApplyRow("r1", 1)])
      .mockResolvedValueOnce([{ status: "pending" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(processRegistryOwnerApplyRow).not.toHaveBeenCalled();
  });

  /**
   * ⚠なぜ必要か(@codex 第5R P1): 無効化(isActive=false)はこのアプリでは「ログインの取り消し」。
   *   ところが権限の読み直しは役割の設定を読むだけで有効かを見ないので、無効にした人の
   *   名前で最大5,000件ぶんの所有者が書き込まれてしまう。
   */
  it("⚠無効にされた実行者のジョブは、1行も処理せず失敗にする", async () => {
    pm.user.findUnique.mockResolvedValue({ id: "u1", role: "admin", isActive: false });
    pm.importJobRow.findMany
      .mockResolvedValueOnce([ownerApplyRow("r1", 1)])
      .mockResolvedValueOnce([{ status: "pending" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(processRegistryOwnerApplyRow).not.toHaveBeenCalled();
    const statuses = pm.importJob.update.mock.calls.map(
      (c) => (c[0].data as { status?: string }).status,
    );
    expect(statuses).toContain("failed");
    // ⚠有効かどうかを実際に読みに行っている
    expect(pm.user.findUnique.mock.calls[0][0].select).toMatchObject({ isActive: true });
  });

  it("PDFを上げた一括取込だけのジョブでは、権限の読み直しをしない（従来どおり）", async () => {
    pm.importJobRow.findMany
      .mockResolvedValueOnce([
        { id: "r1", rowNumber: 1, rawData: { fileName: "x.PDF", stagedKey: "staging/x.pdf" } },
      ])
      .mockResolvedValueOnce([{ status: "success" }]);

    enqueueRegistryPdfBulkJob("j1");
    await waitForIdle();

    expect(getUserPermissions).not.toHaveBeenCalled();
    expect((processRegistryPdfBulkRow as Mock).mock.calls).toHaveLength(1);
  });
});
