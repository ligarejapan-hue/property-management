import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/properties/[id] — 区分専用の欄(部屋番号・現況・持分メモ・専有面積など)を
// 「更新後の種別」で判定する(@codex #505 P2)。mock の形は building-link-patch.test.ts を写す。

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
  roomNo: "201",
  floorNo: 2,
  exclusiveArea: null,
  balconyArea: null,
  layoutType: null,
  orientation: null,
  managementFee: null,
  repairReserveFee: null,
  occupancyStatus: "vacant",
  ownershipShareNote: null,
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

const sentData = () => txMock.property.updateMany.mock.calls[0][0].data as Record<string, unknown>;

describe("PATCH /api/properties/[id] — 区分専用の欄", () => {
  it("区分マンションなら部屋番号・現況・持分メモを保存する", async () => {
    const res = await PATCH(req({ version: 1, roomNo: "305", occupancyStatus: "occupied", ownershipShareNote: "1/2" }), ctx);
    expect(res.status).toBe(200);
    expect(sentData()).toMatchObject({ roomNo: "305", occupancyStatus: "occupied", ownershipShareNote: "1/2" });
  });

  it("区分マンション以外へ送られた区分専用の値は保存しない(null)", async () => {
    prismaMock.property.findUnique.mockResolvedValue({ ...CURRENT, propertyType: "house", buildingId: null, roomNo: null, floorNo: null, occupancyStatus: null });
    await PATCH(req({ version: 1, roomNo: "305", occupancyStatus: "occupied", floorNo: 3 }), ctx);
    expect(sentData()).toMatchObject({ roomNo: null, occupancyStatus: null, floorNo: null });
  });

  it("種別を区分マンション以外へ変えたら、残っている区分専用の欄も消す(物件名と同じ)", async () => {
    applyMock.mockResolvedValue({ action: "unlinked", building: null, previousBuildingId: "b1", renamedFrom: null, warnings: [] });
    await PATCH(req({ version: 1, propertyType: "house" }), ctx);
    const data = sentData();
    for (const k of ["roomNo", "floorNo", "exclusiveArea", "balconyArea", "layoutType", "orientation", "managementFee", "repairReserveFee", "occupancyStatus", "ownershipShareNote"]) {
      expect(data[k], k).toBeNull();
    }
  });

  it("区分（旧）へ変えたときは区分専用の欄を残す", async () => {
    await PATCH(req({ version: 1, propertyType: "unit" }), ctx);
    const data = sentData();
    expect(data).not.toHaveProperty("roomNo");
    expect(data).not.toHaveProperty("occupancyStatus");
  });

  it("区分専用の欄に触れない保存では何も足さない", async () => {
    await PATCH(req({ version: 1, note: "メモだけ" }), ctx);
    expect(sentData()).not.toHaveProperty("roomNo");
  });
});
