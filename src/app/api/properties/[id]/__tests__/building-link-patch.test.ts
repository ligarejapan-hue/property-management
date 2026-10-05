import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/properties/[id] — 版番号を進める更新と同じトランザクションで棟へつなぎ直す
// (設計 2026-10-04 §4.4)。mock の形は edit-lock.test.ts を写す。

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
  getOwnerDisplayConfig: vi.fn(),
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn((x: unknown) => x) }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));

const applyMock = vi.fn();
const auditLinkMock = vi.fn();
vi.mock("@/lib/building-link/apply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/building-link/apply")>();
  return {
    // finalBuildingFields は純関数なので本物を使う(履歴の組み立てを実物で確かめる)。
    finalBuildingFields: actual.finalBuildingFields,
    applyBuildingLink: (...a: unknown[]) => applyMock(...a),
    writeBuildingLinkAudit: (...a: unknown[]) => auditLinkMock(...a),
  };
});

vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    changeLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { PATCH } from "../route";

type PrismaMock = {
  property: { findUnique: Mock; findUniqueOrThrow: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  $transaction: Mock;
};
const prismaMock = prisma as unknown as PrismaMock;

const txMock = {
  property: { updateMany: vi.fn() },
  $queryRaw: vi.fn(async () => []),
};

const CURRENT = {
  id: "p1",
  version: 1,
  createdBy: "user-1",
  assignedTo: null,
  propertyType: "apartment_unit",
  address: "東京都大田区南雪谷1丁目1",
  postalCode: null,
  lotNumber: null,
  buildingNumber: null,
  buildingName: "パークハウス第一",
  buildingId: "b1",
  realEstateNumber: null,
  registryStatus: "unconfirmed",
  dmStatus: "hold",
  caseStatus: "new_case",
  introductionRoute: null,
  dmScenarioId: null,
  note: null,
};

const UPDATED = {
  ...CURRENT,
  version: 2,
  assignee: null,
  creator: null,
  building: { id: "b1", name: "パークハウス第一" },
  propertyOwners: [],
  photos: [],
  nextActions: [],
};

const ctx = { params: Promise.resolve({ id: "p1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/properties/p1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Edit-Screen": "screen-1" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  prismaMock.property.findUnique.mockResolvedValue(CURRENT);
  prismaMock.property.findUniqueOrThrow.mockResolvedValue(UPDATED);
  prismaMock.changeLog.createMany.mockResolvedValue({ count: 0 });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txMock));
  txMock.property.updateMany.mockResolvedValue({ count: 1 });
  (lockPropertyRow as unknown as Mock).mockResolvedValue(undefined);
  (assertNotEditLockedByOther as unknown as Mock).mockResolvedValue(undefined);
  auditLinkMock.mockResolvedValue(undefined);
});

describe("PATCH /api/properties/[id] — 棟へのつなぎ直し", () => {
  it("物件名・種別・住所が変わらず buildingChoice も無ければ apply を呼ばない", async () => {
    const res = await PATCH(req({ version: 1, note: "メモだけ" }), ctx);
    expect(res.status).toBe(200);
    expect(applyMock).not.toHaveBeenCalled();
    expect(auditLinkMock).not.toHaveBeenCalled();
    expect((await res.json()).buildingLink).toBeNull();
  });

  it("同じ物件名を送り直しただけなら apply を呼ばない", async () => {
    await PATCH(req({ version: 1, buildingName: "パークハウス第一" }), ctx);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("物件名を変えたら、更新と同じ tx で apply を呼ぶ(今の棟を渡す)", async () => {
    applyMock.mockResolvedValue({
      action: "linked", building: { id: "b2", name: "別棟" }, previousBuildingId: "b1", renamedFrom: null, warnings: [],
    });
    const res = await PATCH(req({ version: 1, buildingName: "別棟" }), ctx);
    expect(res.status).toBe(200);
    expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      propertyId: "p1", buildingName: "別棟", currentBuildingId: "b1", choice: { kind: "auto" },
    }));
    // ⚠版番号を進める更新の**後**に呼ぶ(apply 側は版番号を進めない)。
    expect(txMock.property.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      applyMock.mock.invocationCallOrder[0],
    );
    expect((await res.json()).buildingLink).toMatchObject({ action: "linked" });
    expect(auditLinkMock).toHaveBeenCalledWith("user-1", "p1", expect.objectContaining({ action: "linked" }));
  });

  it("住所だけ変えても apply を呼ぶ(家屋番号は今の値を渡す)", async () => {
    applyMock.mockResolvedValue({
      action: "kept", building: { id: "b1", name: "パークハウス第一" }, previousBuildingId: "b1", renamedFrom: null, warnings: [],
    });
    await PATCH(req({ version: 1, address: "東京都大田区南雪谷2丁目1" }), ctx);
    expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      address: "東京都大田区南雪谷2丁目1", buildingName: "パークハウス第一", buildingNumber: null, propertyType: "apartment_unit",
    }));
  });

  it("種別を対象外へ変えたら、消した物件名(null)で apply を呼ぶ", async () => {
    applyMock.mockResolvedValue({
      action: "unlinked", building: null, previousBuildingId: "b1", renamedFrom: null, warnings: [],
    });
    await PATCH(req({ version: 1, propertyType: "land" }), ctx);
    expect(applyMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      propertyType: "land", buildingName: null, currentBuildingId: "b1",
    }));
    const logs = prismaMock.changeLog.createMany.mock.calls[0][0].data;
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: "buildingId", oldValue: "b1", newValue: null }),
    ]));
  });

  it("棟の表記にそろえたら、変更履歴の物件名は『そろえた後』になり、棟の変更も残る", async () => {
    applyMock.mockResolvedValue({
      action: "linked", building: { id: "b2", name: "第一ビル" }, previousBuildingId: "b1", renamedFrom: "第１ビル", warnings: [],
    });
    await PATCH(req({ version: 1, buildingName: "第１ビル" }), ctx);
    const logs = prismaMock.changeLog.createMany.mock.calls[0][0].data;
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: "buildingName", oldValue: "パークハウス第一", newValue: "第一ビル" }),
      expect.objectContaining({ fieldName: "buildingId", oldValue: "b1", newValue: "b2" }),
    ]));
    expect(logs.filter((l: { fieldName: string }) => l.fieldName === "buildingName")).toHaveLength(1);
  });

  it("打ち直しても棟の表記へ戻って変わらなければ、物件名の履歴を残さない", async () => {
    applyMock.mockResolvedValue({
      action: "kept", building: { id: "b1", name: "パークハウス第一" }, previousBuildingId: "b1", renamedFrom: "パークハウス第１", warnings: [],
    });
    await PATCH(req({ version: 1, buildingName: "パークハウス第１" }), ctx);
    expect(prismaMock.changeLog.createMany).not.toHaveBeenCalled();
  });

  it("版番号が合わず0件なら apply を呼ばずに 409", async () => {
    txMock.property.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.property.findUnique
      .mockResolvedValueOnce(CURRENT)
      .mockResolvedValueOnce({ registryStatus: "unconfirmed" });
    const res = await PATCH(req({ version: 1, buildingName: "別棟" }), ctx);
    expect(res.status).toBe(409);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("buildingChoice は物件の列として保存しない(送られたら apply を呼ぶ)", async () => {
    applyMock.mockResolvedValue({
      action: "kept", building: { id: "b1", name: "パークハウス第一" }, previousBuildingId: "b1", renamedFrom: null, warnings: [],
    });
    await PATCH(req({ version: 1, buildingChoice: { kind: "auto" } }), ctx);
    expect(txMock.property.updateMany.mock.calls[0][0].data).not.toHaveProperty("buildingChoice");
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("応答のために棟の id と名前を読み直す", async () => {
    await PATCH(req({ version: 1, note: "x" }), ctx);
    expect(prismaMock.property.findUniqueOrThrow.mock.calls[0][0].include.building).toEqual({
      select: { id: true, name: true },
    });
  });
});
