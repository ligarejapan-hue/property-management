/**
 * 取込の取り消しは、その取込が自動で作った棟のうち、物件を消した後に空になったものも消す
 * (@codex P1・2026-10-05)。残すと中身の無い棟が後の自動づけを引き寄せる。
 *
 * - 目印 = 監査ログ building.auto_create の detail.importJobId(migration なし)。
 * - 取込の外の物件もつながっている棟・取込が作っていない棟は消さない。
 * - 取り消しの監査ログには棟の id と残した理由だけ(住所を入れない)。
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

vi.mock("@/lib/prisma", () => ({
  default: {
    importJob: { findUnique: vi.fn(), update: vi.fn() },
    property: { findMany: vi.fn() },
    changeLog: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { POST as rollbackPOST } from "@/app/api/import/jobs/[jobId]/rollback/route";

type PrismaMock = {
  importJob: { findUnique: Mock; update: Mock };
  property: { findMany: Mock };
  changeLog: { findMany: Mock };
  auditLog: { findMany: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-000000000001";
const P2 = "22222222-2222-4222-8222-000000000002";
const B_EMPTY = "33333333-3333-4333-8333-000000000001";
const B_SHARED = "33333333-3333-4333-8333-000000000002";
const B_OTHER = "33333333-3333-4333-8333-000000000003";
const COMPLETED_AT = new Date("2026-01-01T00:05:00Z");
const ADDRESS = "東京都大田区南雪谷1丁目";

const JOB = {
  id: JOB_ID,
  status: "completed" as const,
  jobType: "property_csv" as const,
  executedBy: "u1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: COMPLETED_AT,
  rows: [
    { id: "row-1", rowNumber: 1, status: "success" as const, errorMessage: null, createdId: P1 },
    { id: "row-2", rowNumber: 2, status: "success" as const, errorMessage: null, createdId: P2 },
  ],
};

const noChildren = {
  photos: 0, attachments: 0, propertyOwners: 0, comments: 0, nextActions: 0, dmLogs: 0, investigationLogs: 0,
  dmRecipientDrafts: 0, agentInquiries: 0,
};

/** 棟の偽物(物件を消すと数が減る)。B_SHARED には取込の外の物件が1件つながっている。 */
let buildings: { id: string; address: string; propertyIds: string[]; photos: number }[];
let deletedBuildings: string[];

function makeTx() {
  return {
    importJob: { findUnique: vi.fn(async () => ({ status: "completed" })), update: vi.fn(async () => ({})) },
    dmRecipientDraft: { findMany: vi.fn(async () => []) },
    agentInquiry: { findMany: vi.fn(async () => []) },
    property: {
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const b of buildings) b.propertyIds = b.propertyIds.filter((p) => p !== where.id);
        return {};
      }),
      findUnique: vi.fn(async () => ({ buildingId: "linked-now", buildingName: "今の名前" })),
      // 復元: buildingId を書き戻したら、棟の偽物の部屋のつながりも付け替える。
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if ("buildingId" in data) {
          for (const b of buildings) b.propertyIds = b.propertyIds.filter((p) => p !== where.id);
          const to = buildings.find((b) => b.id === data.buildingId);
          if (to) to.propertyIds.push(where.id);
        }
        return { count: 1 };
      }),
    },
    $queryRaw: vi.fn(async (q: TemplateStringsArray, ...v: unknown[]) => {
      const sql = q.join("?");
      if (sql.includes("FROM buildings")) {
        const ids = v[0] as string[];
        return buildings.filter((b) => ids.includes(b.id)).map((b) => ({ id: b.id }));
      }
      return [];
    }),
    building: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        buildings.some((b) => b.id === where.id) ? { id: where.id } : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        buildings
          .filter((b) => where.id.in.includes(b.id))
          .map((b) => ({ id: b.id, _count: { properties: b.propertyIds.length, photos: b.photos } })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        deletedBuildings.push(...where.id.in);
        buildings = buildings.filter((b) => !where.id.in.includes(b.id));
        return { count: where.id.in.length };
      }),
    },
  };
}

const rollbackRequest = (body: unknown) =>
  new Request("http://localhost/api/import/jobs/x/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof rollbackPOST>[0];

let tx: ReturnType<typeof makeTx>;
beforeEach(() => {
  vi.clearAllMocks();
  buildings = [
    { id: B_EMPTY, address: ADDRESS, propertyIds: [P1, P2], photos: 0 },
    { id: B_SHARED, address: ADDRESS, propertyIds: [P1, "outside-property"], photos: 0 },
    { id: B_OTHER, address: ADDRESS, propertyIds: [P2], photos: 0 },
  ];
  deletedBuildings = [];
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([]);
  pm.importJob.findUnique.mockResolvedValue(JOB);
  pm.property.findMany.mockResolvedValue([
    { id: P1, updatedAt: COMPLETED_AT, _count: noChildren },
    { id: P2, updatedAt: COMPLETED_AT, _count: noChildren },
  ]);
  pm.changeLog.findMany.mockResolvedValue([]);
  // この取込が作った棟は B_EMPTY と B_SHARED(B_OTHER は別の経路で作られた棟)。
  pm.auditLog.findMany.mockResolvedValue([{ targetId: B_EMPTY }, { targetId: B_SHARED }]);
  tx = makeTx();
  pm.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
});

describe("取込の取り消しで、取込が作った空の棟を消す", () => {
  it("空になった棟は消し、取込の外の物件もつながる棟と取込が作っていない棟は残す", async () => {
    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      deletedCount: number;
      buildingCleanup: { deletedBuildingIds: string[]; keptBuildings: { buildingId: string; reason: string }[] };
    };
    expect(json.deletedCount).toBe(2);
    expect(deletedBuildings).toEqual([B_EMPTY]);
    expect(buildings.map((b) => b.id)).toEqual([B_SHARED, B_OTHER]);
    expect(json.buildingCleanup).toEqual({
      deletedBuildingIds: [B_EMPTY],
      keptBuildings: [{ buildingId: B_SHARED, reason: "has_properties" }],
    });
    // 目印はこの取込の id で引く
    expect(pm.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: "building.auto_create", detail: { path: ["importJobId"], equals: JOB_ID } }),
      }),
    );
    // 棟を数えて消すのは物件を消した後
    const lastPropertyDelete = Math.max(...tx.property.delete.mock.invocationCallOrder);
    expect(tx.building.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(lastPropertyDelete);
  });

  it("取り消しの監査ログに棟の id と残した理由を入れる(住所は入れない)", async () => {
    await rollbackPOST(rollbackRequest({ dryRun: false }), { params: Promise.resolve({ jobId: JOB_ID }) });
    const call = (writeAuditLog as unknown as Mock).mock.calls.find(
      (c) => (c[0] as { action: string }).action === "import_job_rollback",
    );
    expect(call).toBeDefined();
    const detail = (call![0] as { detail: Record<string, unknown> }).detail;
    expect(detail.deletedBuildingIds).toEqual([B_EMPTY]);
    expect(detail.keptBuildings).toEqual([{ buildingId: B_SHARED, reason: "has_properties" }]);
    expect(JSON.stringify(detail)).not.toContain("南雪谷");
  });

  it("下見(dryRun)では棟に触らず、消す候補の数だけ返す", async () => {
    const res = await rollbackPOST(rollbackRequest({ dryRun: true }), { params: Promise.resolve({ jobId: JOB_ID }) });
    const json = (await res.json()) as { autoCreatedBuildingCount: number };
    expect(json.autoCreatedBuildingCount).toBe(2);
    expect(pm.$transaction).not.toHaveBeenCalled();
    expect(deletedBuildings).toEqual([]);
  });

  it("取込が棟を作っていなければ棟に触らない", async () => {
    pm.auditLog.findMany.mockResolvedValue([]);
    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(res.status).toBe(200);
    expect(tx.building.findMany).not.toHaveBeenCalled();
    expect(tx.building.deleteMany).not.toHaveBeenCalled();
  });
});

// CSV の重複更新が既存の部屋を、取込で作った棟へつないだ場合: 取り消しは部屋の棟と物件名を
// 前の値へ戻し(版番号を進める)、空になった棟を消す。
describe("取込の取り消しで、重複更新がつないだ棟と物件名も戻す", () => {
  const PU = "22222222-2222-4222-8222-0000000000aa";
  const B_AUTO = "33333333-3333-4333-8333-0000000000aa";
  const B_OLD = "33333333-3333-4333-8333-0000000000bb";
  const LOG_AT = new Date("2026-01-01T00:01:00Z");
  const log = (fieldName: string, oldValue: string | null, newValue: string | null) => ({
    targetId: PU, fieldName, oldValue, newValue, source: "csv_import", changedAt: LOG_AT, changedBy: "u1",
  });
  const setup = (oldBuildingId: string | null, oldName: string | null) => {
    pm.importJob.findUnique.mockResolvedValue({
      ...JOB,
      rows: [{
        id: "row-u", rowNumber: 1, status: "success" as const, createdId: PU,
        errorMessage: `更新[realEstateNumber一致]: 既存物件ID=${PU} (更新項目: buildingId, buildingName)`,
      }],
    });
    pm.property.findMany.mockResolvedValue([{ id: PU, updatedAt: COMPLETED_AT, _count: noChildren }]);
    pm.changeLog.findMany.mockResolvedValue([
      log("buildingId", oldBuildingId, B_AUTO),
      log("buildingName", oldName, "新ビル"),
    ]);
    pm.auditLog.findMany.mockResolvedValue([{ targetId: B_AUTO }]);
    buildings = [{ id: B_AUTO, address: ADDRESS, propertyIds: [PU], photos: 0 }];
    if (oldBuildingId) buildings.push({ id: oldBuildingId, address: ADDRESS, propertyIds: [], photos: 0 });
  };

  it("前の棟と物件名へ戻し(版番号を進める)、空になった取込の棟を消す", async () => {
    setup(B_OLD, "旧ビル");
    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(res.status).toBe(200);
    const upd = tx.property.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(upd.data).toEqual({ buildingId: B_OLD, buildingName: "旧ビル", version: { increment: 1 } });
    expect(deletedBuildings).toEqual([B_AUTO]);
    expect(buildings.find((b) => b.id === B_OLD)?.propertyIds).toEqual([PU]);
    // 戻した後に数える
    expect(tx.building.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.property.updateMany.mock.invocationCallOrder[0]);
  });

  it("前は棟が無かった部屋は棟なしへ戻り、取込の棟は消える", async () => {
    setup(null, null);
    await rollbackPOST(rollbackRequest({ dryRun: false }), { params: Promise.resolve({ jobId: JOB_ID }) });
    const upd = tx.property.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(upd.data).toEqual({ buildingId: null, buildingName: null, version: { increment: 1 } });
    expect(deletedBuildings).toEqual([B_AUTO]);
  });

  it("前の棟がもう無いときは、棟と物件名を戻さず(外部キーで全体を落とさない)理由を出し、取込の棟は残す", async () => {
    setup(B_OLD, "旧ビル");
    buildings = buildings.filter((b) => b.id !== B_OLD);
    const res = await rollbackPOST(rollbackRequest({ dryRun: false }), { params: Promise.resolve({ jobId: JOB_ID }) });
    expect(res.status).toBe(200);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    const json = (await res.json()) as {
      blockedDetails: { reason: string }[];
      buildingCleanup: { keptBuildings: { buildingId: string; reason: string }[] };
    };
    expect(json.blockedDetails.map((b) => b.reason).join()).toContain("restore_building_missing");
    expect(json.buildingCleanup.keptBuildings).toEqual([{ buildingId: B_AUTO, reason: "has_properties" }]);
  });
});
