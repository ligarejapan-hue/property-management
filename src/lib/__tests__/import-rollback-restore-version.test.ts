/**
 * Task 9: 受付帳CSV取込のロールバック(復元)は、Property の編集画面で変えられる項目
 * (note 等)を書き戻すのに version を進めていなかった。編集画面を開いていた人の
 * 保存が、この復元をそのまま黙って上書きできてしまう(Task 7 が謄本取込の法人番号で
 * 直したのと同じ穴)。
 *
 * この経路(`import-rollback-route-phase2.test.ts`)は route 全体を prisma mock で
 * integration しない方針だが、version increment は「実際に tx.property.updateMany へ
 * 渡る data」を確認しないと固定できないため、この1点だけ最小限のフルモックで
 * 振る舞いを確認する。
 */
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
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ deleteEditLocksFor: vi.fn() }));
vi.mock("@/lib/import-job-guard", () => ({ assertImportJobMutable: vi.fn() }));

// classify* は純関数だが、判定ロジック自体は import-rollback.test.ts が別途固定して
// いるため、ここでは「1件が復元対象になった」状態を直接作って version increment の
// 確認に絞る。
vi.mock("@/lib/import-rollback", () => ({
  classifyRowsForRollback: vi.fn(() => [
    { rowId: "row-1", rowNumber: 1, category: "restore", createdId: PROP_ID },
  ]),
  classifyUpdateFieldsForRestore: vi.fn(() => [
    { fieldName: "note", status: "restorable", restoreValue: "元のメモ" },
  ]),
  ROLLBACK_WINDOW_UPPER_TOLERANCE_MS: 5000,
}));
vi.mock("@/lib/import-row-display", () => ({
  extractUpdatedFields: vi.fn(() => ["note"]),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn(), update: vi.fn() },
    property: { findMany: vi.fn() },
    changeLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { POST as rollbackPOST } from "@/app/api/import/jobs/[jobId]/rollback/route";

type PrismaMock = {
  importJob: { findUnique: Mock; update: Mock };
  property: { findMany: Mock };
  changeLog: { findMany: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROP_ID = "22222222-2222-4222-8222-222222222222";
const COMPLETED_AT = new Date("2026-01-01T00:05:00Z");

const JOB = {
  id: JOB_ID,
  status: "completed" as const,
  jobType: "property_csv" as const,
  executedBy: "u1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: COMPLETED_AT,
  rows: [
    {
      id: "row-1",
      rowNumber: 1,
      status: "success" as const,
      errorMessage: "更新[realEstateNumber一致]: 既存物件ID=x (更新項目: note)",
      createdId: PROP_ID,
    },
  ],
};

const rollbackRequest = (body: unknown) =>
  new Request("http://localhost/api/import/jobs/x/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof rollbackPOST>[0];

describe("ロールバックの復元(update)は version を進める", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
    (getUserPermissions as unknown as Mock).mockResolvedValue([]);
    pm.importJob.findUnique.mockResolvedValue(JOB);
    pm.property.findMany.mockResolvedValue([
      {
        id: PROP_ID,
        updatedAt: COMPLETED_AT,
        _count: {
          photos: 0,
          attachments: 0,
          propertyOwners: 0,
          comments: 0,
          nextActions: 0,
          dmLogs: 0,
          investigationLogs: 0,
        },
      },
    ]);
    pm.changeLog.findMany.mockResolvedValue([]);
  });

  it("tx.property.updateMany に渡る data は version: { increment: 1 } を含む", async () => {
    let updateManyCall: { where: unknown; data: Record<string, unknown> } | null = null;
    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const txClient = {
        importJob: {
          findUnique: vi.fn(async () => ({ status: "completed" })),
          update: vi.fn(async () => ({})),
        },
        property: {
          delete: vi.fn(async () => ({})),
          findUnique: vi.fn(async () => ({ note: "旧メモ" })),
          updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
            updateManyCall = args;
            return { count: 1 };
          }),
        },
      };
      return fn(txClient);
    });

    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), {
      params: Promise.resolve({ jobId: JOB_ID }),
    });

    expect(res.status).toBe(200);
    expect(updateManyCall).not.toBeNull();
    const call = updateManyCall as unknown as { where: unknown; data: Record<string, unknown> };
    expect(call.data.version).toEqual({ increment: 1 });
    // 復元対象の項目自体は従来どおり書く(version 追加で消えていないことの確認)。
    expect(call.data.note).toBe("元のメモ");
  });
});
