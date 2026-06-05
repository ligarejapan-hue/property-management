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
      updateMany: vi.fn(),
    },
  },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { recordChanges, PROPERTY_TRACKED_FIELDS } from "@/lib/change-log";
import { POST } from "../../app/api/properties/bulk-update/route";

const pm = prisma as unknown as {
  property: { findMany: Mock; updateMany: Mock };
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
