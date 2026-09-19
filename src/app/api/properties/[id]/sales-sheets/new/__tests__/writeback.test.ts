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
    // 実 parseJsonBody と同じ挙動: 空ボディ→{} / 不正JSON→throw。
    parseJsonBody: vi.fn(async (req: Request) => {
      const text = await req.text();
      return text.trim() === "" ? {} : JSON.parse(text);
    }),
    handleApiError: vi.fn((e: unknown) => {
      const err = e as { status?: number; message?: string; code?: string; issues?: unknown[] };
      if (typeof err?.status === "number") {
        return Response.json(
          { error: { message: err.message, code: err.code } },
          { status: err.status },
        );
      }
      if (Array.isArray(err?.issues)) {
        return Response.json(
          { error: { message: "invalid input", code: "VALIDATION_ERROR" } },
          { status: 422 },
        );
      }
      return Response.json(
        { error: { message: "internal", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
  };
});

vi.mock("@/lib/permissions", () => ({
  hasPermission: vi.fn(
    (
      perms: { resource: string; action: string; granted: boolean }[],
      resource: string,
      action: string,
    ) => perms.some((p) => p.resource === resource && p.action === action && p.granted),
  ),
}));

vi.mock("@/lib/property-access", () => ({
  canAccessPropertyRecord: vi.fn(
    (
      session: { id: string; role: string },
      property: { createdBy: string; assignedTo: string | null },
    ) => {
      if (session.role !== "field_staff") return true;
      return property.createdBy === session.id || property.assignedTo === session.id;
    },
  ),
}));

const baseProperty = {
  id: "11111111-1111-1111-1111-111111111111",
  createdBy: "u1",
  assignedTo: "u1",
  propertyType: "land",
  address: "東京都新宿区1-1-1",
  zoningDistrict: null,
  buildingCoverageRatio: null,
  floorAreaRatio: null,
  roadType: null,
  roadWidth: null,
  occupancyStatus: null,
  roomNo: null,
  exclusiveArea: null,
  balconyArea: null,
  layoutType: null,
  floorNo: null,
  orientation: null,
  managementFee: null,
  repairReserveFee: null,
  buildingName: null,
  version: 1,
  salePrice: null,
  saleTaxType: null,
  saleTaxAmount: null,
  access: null,
  landArea: null,
  landAreaMethod: null,
  totalFloorArea: null,
  builtYear: null,
  builtMonth: null,
  structureType: null,
  aboveFloors: null,
  basementFloors: null,
  parking: null,
  totalUnits: null,
  grossYield: null,
  expectedIncome: null,
  building: null as null | { id: string; version: number },
};

const baseMansion = { ...baseProperty, propertyType: "apartment_unit" };

// prisma の mock。$transaction はコールバックへ pm をそのまま渡す(実トランザクションは張らない)。
vi.mock("@/lib/prisma", () => {
  const mock = {
    property: {
      findUnique: vi.fn(async () => baseProperty),
      update: vi.fn(async () => ({})),
    },
    building: {
      update: vi.fn(async () => ({})),
    },
    changeLog: {
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    salesSheetDesign: {
      create: vi.fn(async () => ({ id: "sheet-1" })),
    },
    propertyOwner: {
      findFirst: vi.fn(async () => null),
    },
    propertyPhoto: {
      findMany: vi.fn(async () => []),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mock)),
  };
  return { default: mock };
});

// createDesign: 実装は使わず、渡された tx(=prisma mock) の salesSheetDesign.create を叩く
// だけの薄いモック(このテストでは writeback の呼ばれ方だけを見るため)。
vi.mock("@/lib/sales-sheet/design-service", () => ({
  createDesign: vi.fn(
    async (
      input: { propertyId: string; document: unknown; userId: string; templateId?: string | null },
      tx: { salesSheetDesign: { create: (args: unknown) => Promise<{ id: string }> } },
    ) =>
      tx.salesSheetDesign.create({
        data: {
          propertyId: input.propertyId,
          title: "無題の販売図面",
          document: input.document,
          templateId: input.templateId ?? null,
          createdBy: input.userId,
          updatedBy: input.userId,
        },
      }),
  ),
}));

vi.mock("@/lib/sales-sheet/authorize-document-images", () => ({
  isImageKeyAuthorizedForProperty: vi.fn(async () => true),
}));

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { POST } from "../route";

type PrismaMock = {
  property: { findUnique: Mock; update: Mock };
  building: { update: Mock };
  changeLog: { createMany: Mock };
  salesSheetDesign: { create: Mock };
  propertyOwner: { findFirst: Mock };
  propertyPhoto: { findMany: Mock };
  $queryRaw: Mock;
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const updateMock = pm.property.update;
const buildingUpdateMock = pm.building.update;
const changeLogCreateManyMock = pm.changeLog.createMany;
const propertyFindMock = pm.property.findUnique;
const designCreateMock = pm.salesSheetDesign.create;

const ADMIN_SESSION = { id: "u1", email: "a@b.com", name: "Admin", role: "admin" };
const WRITE_PERMS = [{ resource: "property", action: "write", granted: true }];

const ctx = { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) };
const req = (body: unknown) =>
  new Request("http://localhost:3000/api/properties/x/sales-sheets/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue(ADMIN_SESSION);
  (getUserPermissions as Mock).mockResolvedValue(WRITE_PERMS);
  propertyFindMock.mockResolvedValue(baseProperty);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyPhoto.findMany.mockResolvedValue([]);
  designCreateMock.mockResolvedValue({ id: "sheet-1" });
});

describe("POST /sales-sheets/new — 物件への保存", () => {
  it("既定(チェックON)で変わった欄だけ物件を更新し、変更履歴を1欄1行残す", async () => {
    const res = await POST(req({ price: "3480", access: "○○線 徒歩8分" }), ctx);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyWriteback).toEqual({ saved: ["価格", "交通"], unreadable: [], conflict: false });
    // property.update は1回・ChangeLog は2行
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].data).toMatchObject({
      salePrice: 3480,
      access: "○○線 徒歩8分",
      version: { increment: 1 },
    });
    expect(changeLogCreateManyMock.mock.calls[0][0].data).toHaveLength(2);
  });

  it("チェックOFFなら物件を更新しない", async () => {
    const res = await POST(req({ price: "3480", saveToProperty: false }), ctx);
    expect(res.status).toBe(201);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback).toEqual({ saved: [], unreadable: [], conflict: false });
  });

  it("読み取れない値は保存せず知らせに出す", async () => {
    const res = await POST(req({ price: "応談" }), ctx);
    const json = await res.json();
    expect(json.propertyWriteback.saved).toEqual([]);
    expect(json.propertyWriteback.unreadable).toEqual(["価格"]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("他の人が先に更新していたら物件は保存せず図面は作る", async () => {
    // 現在の version は 5、画面が持っていたのは 4
    propertyFindMock.mockResolvedValueOnce({ ...baseProperty, version: 5 });
    const res = await POST(req({ price: "3480", propertyVersion: 4 }), ctx);
    expect(res.status).toBe(201);
    expect(updateMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback.conflict).toBe(true);
    // 図面自体は作られる(原子性は保つが、保存の巻き戻り対象ではない)。
    expect(designCreateMock).toHaveBeenCalledTimes(1);
  });

  it("区分は棟へ保存する", async () => {
    propertyFindMock.mockResolvedValueOnce({ ...baseMansion, building: { id: "b1", version: 1 } });
    const res = await POST(req({ structure: "RC", totalUnits: "48" }), ctx);
    expect(res.status).toBe(201);
    expect(buildingUpdateMock).toHaveBeenCalledTimes(1);
    expect(buildingUpdateMock.mock.calls[0][0].data).toMatchObject({
      structureType: "RC",
      totalUnits: 48,
      version: { increment: 1 },
    });
  });

  it("一棟は棟へ保存しない(一棟物件は building relation を持たない前提)", async () => {
    propertyFindMock.mockResolvedValueOnce({ ...baseProperty, propertyType: "apartment_building" });
    const res = await POST(req({ totalUnits: "12" }), ctx);
    expect(res.status).toBe(201);
    expect(buildingUpdateMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0].data).toMatchObject({ totalUnits: 12 });
  });

  it("保存の途中で失敗したら図面も作らない", async () => {
    updateMock.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ price: "3480" }), ctx);
    // 単体テストの prisma mock は実トランザクションを張らないため巻き戻りそのものは
    // 検証できない(原子性は「1つの $transaction にまとめてある」ことで担保し、レビューで
    // 確認する)。ここでは応答が 500 であることだけを確かめる。
    expect(res.status).toBe(500);
  });
});
