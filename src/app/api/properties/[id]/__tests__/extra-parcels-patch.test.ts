import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/properties/[id] — 2筆目以降の土地・2棟目以降の建物(2026-11-05 案A 1回目)。mock の形は unit-only-fields-patch.test.ts を写す。

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
  propertyType: "house",
  address: "東京都大田区南雪谷1丁目1",
  postalCode: null,
  lotNumber: null,
  buildingNumber: null,
  buildingName: "パークハウス第一",
  buildingId: null,
  extraParcels: [],
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

const ROW = { id: "r1", kind: "land", location: "", number: "１番２", realEstateNumber: "", area: "61.95" };
const logs = () => prismaMock.changeLog.createMany.mock.calls.flatMap((c) => (c[0] as { data: Array<Record<string, unknown>> }).data);

describe("PATCH /api/properties/[id] — ほかの土地・建物", () => {
  it("整えて保存し、変更履歴は読める文字で残す", async () => {
    const res = await PATCH(req({ version: 1, extraParcels: [ROW] }), ctx);
    expect(res.status).toBe(200);
    expect(sentData().extraParcels).toEqual([{ id: "r1", kind: "land", location: null, number: "1番2", realEstateNumber: null, area: 61.95 }]);
    expect(logs()).toContainEqual(expect.objectContaining({ fieldName: "extraParcels", oldValue: null, newValue: "土地 1番2 61.95㎡" }));
  });
  it("同じ内容を送り直しただけなら履歴を残さない", async () => {
    prismaMock.property.findUnique.mockResolvedValue({ ...CURRENT, extraParcels: [{ id: "r1", kind: "land", location: null, number: "1番2", realEstateNumber: null, area: 61.95 }] });
    await PATCH(req({ version: 1, extraParcels: [ROW] }), ctx);
    expect(logs().some((l) => l.fieldName === "extraParcels")).toBe(false);
  });
  it("地番が空・面積が数でない行は 422(保存しない)", async () => {
    for (const bad of [{ ...ROW, number: " " }, { ...ROW, area: "約60" }]) {
      txMock.property.updateMany.mockClear();
      const res = await PATCH(req({ version: 1, extraParcels: [bad] }), ctx);
      expect(res.status).not.toBe(200);
      expect(txMock.property.updateMany).not.toHaveBeenCalled();
    }
  });
  it("全部消したら空の一覧で保存する", async () => {
    prismaMock.property.findUnique.mockResolvedValue({ ...CURRENT, extraParcels: [{ id: "r1", kind: "land", location: null, number: "1番2", realEstateNumber: null, area: null }] });
    await PATCH(req({ version: 1, extraParcels: [] }), ctx);
    expect(sentData().extraParcels).toEqual([]);
    expect(logs()).toContainEqual(expect.objectContaining({ fieldName: "extraParcels", oldValue: "土地 1番2", newValue: null }));
  });
});
