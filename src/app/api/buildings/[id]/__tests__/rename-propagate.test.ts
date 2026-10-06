/**
 * PATCH /api/buildings/[id]: 棟の名前を直したら全部屋の物件名へ反映する(段3・Task 14)。
 * 編集中の鍵が1件でもあれば 409 UNITS_EDIT_LOCKED で、トランザクションごと失敗する。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const sessionRole = vi.hoisted(() => ({ value: "admin" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  class MockNextResponse extends Response {
    static json = (b: unknown, init?: ResponseInit) => Response.json(b, init);
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});
vi.mock("@/lib/api-helpers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-helpers")>("@/lib/api-helpers");
  return {
    ...actual,
    getApiSession: vi.fn(async () => ({ id: "user-1", role: sessionRole.value })),
    getUserPermissions: vi.fn(async () => []),
  };
});
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn(), BUILDING_TRACKED_FIELDS: [] }));

const { lockMock, countMock, propagateMock, lockUnitsMock, prismaMock } = vi.hoisted(() => {
  const prismaMock = {
    building: { findUnique: vi.fn(), updateMany: vi.fn() },
    changeLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return { lockMock: vi.fn(), countMock: vi.fn(), propagateMock: vi.fn(), lockUnitsMock: vi.fn(), prismaMock };
});
vi.mock("@/lib/edit-lock/row-locks", () => ({ lockBuildingRowNoKeyUpdate: lockMock }));
vi.mock("@/lib/building-link/rename", async () => {
  const actual = await vi.importActual<typeof import("@/lib/building-link/rename")>("@/lib/building-link/rename");
  return {
    ...actual,
    countEditLockedUnits: countMock,
    propagateBuildingName: propagateMock,
    lockBuildingUnits: lockUnitsMock,
  };
});
vi.mock("@/lib/prisma", () => ({ default: prismaMock }));

import { writeAuditLog } from "@/lib/audit";
import { PATCH } from "../route";

const EXISTING = {
  id: "b1", version: 1, name: "旧マンション", address: "東京都○○区1-1-1",
  postalCode: null, lotNumber: null, realEstateNumber: null, totalFloors: null, totalUnits: null,
  builtYear: null, structureType: null, managementCompany: null, builtMonth: null,
  basementFloors: null, gpsLat: null, gpsLng: null, note: null,
};

async function callPatch(body: Record<string, unknown>) {
  const req = new Request("http://localhost:3000/api/buildings/b1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, ...body }),
  });
  return PATCH(req as never, { params: Promise.resolve({ id: "b1" }) });
}

const UNITS = [{ id: "p1", buildingName: "旧", createdBy: "user-1", assignedTo: null }];
const CHANGE_LOGS = [
  { targetTable: "properties", targetId: "p1", fieldName: "buildingName", oldValue: "旧", newValue: "新マンション", source: "manual", changedBy: "user-1" },
];

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.building.findUnique.mockResolvedValue(EXISTING);
  prismaMock.building.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prismaMock));
  sessionRole.value = "admin";
  lockUnitsMock.mockResolvedValue(UNITS);
  countMock.mockResolvedValue(0);
  propagateMock.mockResolvedValue({ updated: 1, changeLogs: CHANGE_LOGS });
});

describe("PATCH /api/buildings/[id] — 名前の反映", () => {
  it("名前を変えて編集中の鍵が0件なら、部屋へ反映し、変更履歴と監査ログ(件数だけ)を残す", async () => {
    const res = await callPatch({ name: " 新マンション " });
    expect(res.status).toBe(200);
    expect(lockMock).toHaveBeenCalledWith(prismaMock, "b1");
    // ロック順: 棟の行ロック → 棟の更新 → 鍵の数え直し
    const order = (m: Mock) => m.mock.invocationCallOrder[0];
    expect(order(lockMock)).toBeLessThan(order(prismaMock.building.updateMany));
    expect(order(prismaMock.building.updateMany)).toBeLessThan(order(lockUnitsMock));
    expect(order(lockUnitsMock)).toBeLessThan(order(countMock));
    expect(order(countMock)).toBeLessThan(order(propagateMock));
    expect(countMock).toHaveBeenCalledWith(prismaMock, "b1");
    // 前後の空白は落として棟にも部屋にも同じ名前を書く
    expect(prismaMock.building.updateMany.mock.calls[0][0].data.name).toBe("新マンション");
    expect(propagateMock).toHaveBeenCalledWith(prismaMock, {
      units: UNITS, newName: "新マンション", userId: "user-1",
    });
    expect(prismaMock.changeLog.createMany).toHaveBeenCalledWith({ data: CHANGE_LOGS });
    const audits = (writeAuditLog as Mock).mock.calls.map((c) => c[0]);
    expect(audits).toContainEqual({
      userId: "user-1", action: "building.rename_propagate", targetTable: "buildings",
      targetId: "b1", detail: { updatedUnits: 1 },
    });
  });

  it("編集中の鍵が1件以上なら 409 UNITS_EDIT_LOCKED。反映せず、棟の更新もトランザクションごと失敗する", async () => {
    countMock.mockResolvedValue(2);
    // ⚠巻き戻し自体は Prisma の対話型トランザクション(コールバックが投げたら rollback)に任せている。
    //   このテストが確かめるのは「反映・変更履歴は一度も呼ばれず、409 が表に出る」こと。
    // 本物のトランザクションと同じく、投げられたら tx 内の書き込みは無かったことになる
    const committed: string[] = [];
    prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb(prismaMock); // 投げれば伝わり、ここから先(commit)には来ない
      committed.push("commit");
      return result;
    });
    const res = await callPatch({ name: "新マンション" });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("UNITS_EDIT_LOCKED");
    expect(propagateMock).not.toHaveBeenCalled();
    expect(prismaMock.changeLog.createMany).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
    const actions = (writeAuditLog as Mock).mock.calls.map((c) => c[0].action);
    expect(actions).not.toContain("building.rename_propagate");
    expect(actions).not.toContain("update");
  });

  it("名前を変えない保存では、棟の行ロックも鍵の数え直しも反映もしない", async () => {
    const res = await callPatch({ name: " 旧マンション ", note: "メモ" });
    expect(res.status).toBe(200);
    // 空白だけの違いでも、余白つきの名前は保存しない
    expect(prismaMock.building.updateMany.mock.calls[0][0].data.name).toBe("旧マンション");
    expect(lockMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
    const actions = (writeAuditLog as Mock).mock.calls.map((c) => c[0].action);
    expect(actions).not.toContain("building.rename_propagate");
  });

  it("応答にも監査ログにも、編集中の人の名前・住所は入らない", async () => {
    countMock.mockResolvedValue(1);
    const res = await callPatch({ name: "新マンション" });
    const text = JSON.stringify(await res.json());
    expect(text).toContain("1件");
    expect(text).not.toMatch(/user-1|編集している|さん/);
    expect(JSON.stringify((writeAuditLog as Mock).mock.calls)).not.toContain("東京都");
  });

  it("版番号が食い違えば(書き込みが0件)従来どおり 409 CONFLICT で、反映はしない", async () => {
    prismaMock.building.updateMany.mockResolvedValue({ count: 0 });
    const res = await callPatch({ name: "新マンション" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(countMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it("field_staff: 担当外の部屋が1件でもあれば 403 で、反映しない", async () => {
    sessionRole.value = "field_staff";
    lockUnitsMock.mockResolvedValue([
      ...UNITS,
      { id: "p9", buildingName: "旧", createdBy: "someone", assignedTo: null },
    ]);
    const res = await callPatch({ name: "新マンション" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    // ロックして読んだ行で判定する(別の count は発行しない)
    expect(lockUnitsMock).toHaveBeenCalledWith(prismaMock, "b1");
    expect(countMock).not.toHaveBeenCalled();
    expect(propagateMock).not.toHaveBeenCalled();
  });

  it("field_staff: 自分の部屋だけなら反映できる", async () => {
    sessionRole.value = "field_staff";
    const res = await callPatch({ name: "新マンション" });
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledTimes(1);
  });

  it("field_staff 以外の役割は、担当外の部屋があっても反映できる", async () => {
    sessionRole.value = "office_staff";
    lockUnitsMock.mockResolvedValue([
      { id: "p9", buildingName: "旧", createdBy: "someone", assignedTo: null },
    ]);
    const res = await callPatch({ name: "新マンション" });
    expect(res.status).toBe(200);
    expect(propagateMock).toHaveBeenCalledTimes(1);
  });

  it("field_staff でも名前を変えない保存では担当の確認をしない", async () => {
    sessionRole.value = "field_staff";
    const res = await callPatch({ note: "メモ" });
    expect(res.status).toBe(200);
    expect(lockUnitsMock).not.toHaveBeenCalled();
  });
});
