/**
 * POST /api/properties/bulk-update のクエリ整形テスト（F14 perf）。
 *
 * - 変更ログ用 findMany が必要最小限の select（id + 更新可能な追跡4列）に絞られている
 *   = 全列 over-fetch していない
 * - recordChanges が物件ごとに従来と同等の payload（oldValues=current / newValues=
 *   updateFields / trackedFields=PROPERTY_TRACKED_FIELDS / source=manual）で呼ばれる
 *   = 件数・内容を保持（直列 → Promise.all 並行化しても観測挙動は不変）
 * - updateMany は accessibleIds + version increment（既存仕様不変）
 * - レスポンス（updatedCount / message）と権限（403）/ 該当0件（404）/ 空更新（422）が不変
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
const { syncAfter } = vi.hoisted(() => ({ syncAfter: vi.fn(async () => undefined) }));
vi.mock("@/lib/deals/schedule-sync", () => ({ syncDealScheduleAfterCaseStatus: syncAfter }));

vi.mock("@/lib/change-log", async () => {
  const actual = await vi.importActual<typeof import("../change-log")>(
    "../change-log",
  );
  return {
    ...actual,
    recordChanges: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    property: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      // 所有者が無い物件の数(送付可にするときだけ数える・2026-11-14)。既定=0件=全部に所有者がいる
      count: vi.fn(async () => 0),
    },
    deal: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    changeLog: { create: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { POST } from "../../app/api/properties/bulk-update/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; findUnique: Mock; updateMany: Mock; count: Mock };
  deal: { findMany: Mock; updateMany: Mock };
  changeLog: { create: Mock };
  $transaction: Mock;
};
const recordChangesMock = recordChanges as unknown as Mock;

const PERMS_WRITE = [{ resource: "property", action: "write", granted: true }];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/properties/bulk-update", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as import("next/server").NextRequest;
}

const VALID_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const ASSIGNEE_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue(PERMS_WRITE);
});

describe("POST /api/properties/bulk-update — select 縮小 (F14)", () => {
  it("findMany は id + 更新可能な追跡4列のみ select する（全列 over-fetch しない）", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "hold", assignedTo: null },
    ]);
    pm.property.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(
      makeRequest({ propertyIds: [VALID_IDS[0]], updates: { caseStatus: "contacting_owner" } }),
    );
    expect(res.status).toBe(200);

    expect(pm.property.findMany).toHaveBeenCalledTimes(1);
    const arg = pm.property.findMany.mock.calls[0][0];
    expect(arg.select).toEqual({
      id: true,
      caseStatus: true,
      registryStatus: true,
      dmStatus: true,
      assignedTo: true,
    });
  });

  it("select の列は bulkUpdateSchema.updates の全更新キーを包含する（oldValue 欠落で null 誤記録を防ぐ）", async () => {
    // どの更新キーを送っても oldValues が select 済みであることを保証する回帰。
    pm.property.findMany.mockResolvedValue([
      { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "hold", assignedTo: null },
    ]);
    pm.property.updateMany.mockResolvedValue({ count: 1 });

    await POST(
      makeRequest({
        propertyIds: [VALID_IDS[0]],
        updates: { caseStatus: "sold", registryStatus: "obtained", dmStatus: "send", assignedTo: ASSIGNEE_ID },
      }),
    );
    const selected = Object.keys(pm.property.findMany.mock.calls[0][0].select);
    for (const key of ["caseStatus", "registryStatus", "dmStatus", "assignedTo"]) {
      expect(selected).toContain(key);
    }
  });
});

describe("POST /api/properties/bulk-update — changeLog 内容保持", () => {
  it("recordChanges が物件ごとに従来と同等の payload で呼ばれる", async () => {
    const current0 = { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "hold", assignedTo: null };
    const current1 = { id: VALID_IDS[1], caseStatus: "contacting_owner", registryStatus: "scheduled", dmStatus: "send", assignedTo: ASSIGNEE_ID };
    pm.property.findMany.mockResolvedValue([current0, current1]);
    pm.property.updateMany.mockResolvedValue({ count: 2 });

    await POST(
      makeRequest({ propertyIds: VALID_IDS, updates: { caseStatus: "sold" } }),
    );

    expect(recordChangesMock).toHaveBeenCalledTimes(2);
    expect(recordChangesMock).toHaveBeenCalledWith({
      targetTable: "properties",
      targetId: VALID_IDS[0],
      changedBy: "user-1",
      oldValues: current0,
      newValues: { caseStatus: "sold" },
      trackedFields: PROPERTY_TRACKED_FIELDS,
      source: "manual",
    });
    expect(recordChangesMock).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: VALID_IDS[1], newValues: { caseStatus: "sold" } }),
    );
  });
});

describe("POST /api/properties/bulk-update — 既存仕様不変", () => {
  it("updateMany は accessibleIds + version increment（更新フィールド含む）", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "hold", assignedTo: null },
    ]);
    pm.property.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(
      makeRequest({ propertyIds: [VALID_IDS[0]], updates: { dmStatus: "send" } }),
    );
    const json = (await res.json()) as { updatedCount: number; message: string };
    expect(json.updatedCount).toBe(1);
    expect(json.message).toContain("1");

    const upArg = pm.property.updateMany.mock.calls[0][0];
    expect(upArg.where).toEqual({ id: { in: [VALID_IDS[0]] } });
    expect(upArg.data).toMatchObject({ dmStatus: "send", version: { increment: 1 } });
  });

  describe("取引の状態との連動", () => {
    const PID = "11111111-1111-4111-8111-111111111111";
    const setup = () => {
      pm.property.findMany.mockResolvedValue([{ id: PID, caseStatus: "on_sale", registryStatus: "unconfirmed", dmStatus: "send", assignedTo: null }]);
      pm.property.updateMany.mockResolvedValue({ count: 1 });
      pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    };
    it("案件ステータスを変えた物件の取引をそろえる", async () => {
      setup();
      pm.deal.findMany.mockResolvedValueOnce([{ propertyId: PID }]).mockResolvedValueOnce([{ id: "d1", status: "considering" }]);
      pm.property.findUnique.mockResolvedValue({ caseStatus: "contracted" });
      pm.deal.updateMany.mockResolvedValue({ count: 1 });
      const res = await POST(makeRequest({ propertyIds: [PID], updates: { caseStatus: "contracted" } }));
      expect(res.status).toBe(200);
      expect(pm.deal.updateMany).toHaveBeenCalledWith({
        where: { id: "d1", status: "considering" }, data: { status: "contracted", version: { increment: 1 } },
      });
    });
    it("連動で決済済になった取引を段取りに伝える", async () => {
      setup();
      syncAfter.mockClear();
      pm.deal.findMany.mockResolvedValueOnce([{ propertyId: PID }]).mockResolvedValueOnce([{ id: "d1", status: "contracted" }]);
      pm.property.findUnique.mockResolvedValue({ caseStatus: "sold" });
      pm.deal.updateMany.mockResolvedValue({ count: 1 });
      await POST(makeRequest({ propertyIds: [PID], updates: { caseStatus: "sold" } }));
      expect(syncAfter).toHaveBeenCalledWith({ dealId: "d1", status: "settled" }, expect.any(String));
    });
    it("案件ステータス以外の一括変更では取引を見ない", async () => {
      setup();
      pm.deal.findMany.mockClear();
      await POST(makeRequest({ propertyIds: [PID], updates: { dmStatus: "hold" } }));
      expect(pm.deal.findMany).not.toHaveBeenCalled();
    });
    it("そろえるのに失敗しても一括変更は成功のまま", async () => {
      setup();
      pm.deal.findMany.mockResolvedValueOnce([{ propertyId: PID }]);
      pm.$transaction.mockRejectedValueOnce(new Error("boom"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await POST(makeRequest({ propertyIds: [PID], updates: { caseStatus: "contracted" } }));
      expect(res.status).toBe(200);
      spy.mockRestore();
    });
  });

  it("field_staff は自分の物件のみ（where に OR scope を付与）", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "fs-1", role: "field_staff" });
    pm.property.findMany.mockResolvedValue([
      { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "hold", assignedTo: "fs-1" },
    ]);
    pm.property.updateMany.mockResolvedValue({ count: 1 });

    await POST(makeRequest({ propertyIds: [VALID_IDS[0]], updates: { caseStatus: "contacting_owner" } }));
    const whereArg = pm.property.findMany.mock.calls[0][0].where;
    expect(whereArg.OR).toEqual([{ createdBy: "fs-1" }, { assignedTo: "fs-1" }]);
  });

  it("property:write 権限がなければ 403（findMany 未実行）", async () => {
    (getUserPermissions as Mock).mockResolvedValue([]);
    const res = await POST(
      makeRequest({ propertyIds: [VALID_IDS[0]], updates: { caseStatus: "contacting_owner" } }),
    );
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("該当0件なら 404（updateMany / recordChanges 未実行）", async () => {
    pm.property.findMany.mockResolvedValue([]);
    const res = await POST(
      makeRequest({ propertyIds: [VALID_IDS[0]], updates: { caseStatus: "contacting_owner" } }),
    );
    expect(res.status).toBe(404);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(recordChangesMock).not.toHaveBeenCalled();
  });

  it("更新フィールドが空なら 422", async () => {
    const res = await POST(makeRequest({ propertyIds: [VALID_IDS[0]], updates: {} }));
    expect(res.status).toBe(422);
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/properties/bulk-update — 所有者が入っていない物件は送付可にできない(2026-11-14)", () => {
  it("所有者の無い物件が含まれていれば 422 で断り、何も書かない", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "hold", assignedTo: null },
    ]);
    pm.property.count.mockResolvedValueOnce(1);
    pm.property.updateMany.mockClear();
    const res = await POST(makeRequest({ propertyIds: [VALID_IDS[0]], updates: { dmStatus: "send" } }));
    expect(res.status).toBe(422);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("送付可以外へのまとめて変更では数えない", async () => {
    pm.property.findMany.mockResolvedValue([
      { id: VALID_IDS[0], caseStatus: "new_case", registryStatus: "unconfirmed", dmStatus: "send", assignedTo: null },
    ]);
    pm.property.updateMany.mockResolvedValue({ count: 1 });
    pm.property.count.mockClear();
    await POST(makeRequest({ propertyIds: [VALID_IDS[0]], updates: { dmStatus: "hold" } }));
    expect(pm.property.count).not.toHaveBeenCalled();
  });
});
