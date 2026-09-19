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

type BuildingFixture = {
  id: string;
  version: number;
  name?: string;
  totalFloors: number | null;
  builtYear: number | null;
  builtMonth: number | null;
  structureType: string | null;
  basementFloors: number | null;
  managementCompany?: string | null;
  totalUnits: number | null;
};

// route.ts は「最初の読み取り(アクセス制御・document組み立て用)」と「FOR UPDATE 後の
// 読み直し(writeback用・C1)」の2回 property.findUnique を呼ぶ。この mock はどちらの
// select にも対応できるよう、両方で使うフィールドを1つのオブジェクトにまとめて持つ。
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
  building: null as BuildingFixture | null,
};

const baseMansion = { ...baseProperty, propertyType: "apartment_unit" };

const testBuilding: BuildingFixture = {
  id: "b1",
  version: 1,
  name: "テストレジデンス",
  totalFloors: null,
  builtYear: null,
  builtMonth: null,
  structureType: null,
  basementFloors: null,
  managementCompany: null,
  totalUnits: null,
};

// prisma の mock。$transaction はコールバックへ mock 自身(= 下の pm)をそのまま渡す
// (実トランザクションは張らない・呼び出しの配線だけを見る)。
vi.mock("@/lib/prisma", () => {
  const mock = {
    property: {
      findUnique: vi.fn(async () => baseProperty),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    building: {
      updateMany: vi.fn(async () => ({ count: 1 })),
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
import { createDesign } from "@/lib/sales-sheet/design-service";
import { POST } from "../route";

type PrismaMock = {
  property: { findUnique: Mock; updateMany: Mock };
  building: { updateMany: Mock };
  changeLog: { createMany: Mock };
  salesSheetDesign: { create: Mock };
  propertyOwner: { findFirst: Mock };
  propertyPhoto: { findMany: Mock };
  $queryRaw: Mock;
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const updateManyMock = pm.property.updateMany;
const buildingUpdateManyMock = pm.building.updateMany;
const changeLogCreateManyMock = pm.changeLog.createMany;
const propertyFindMock = pm.property.findUnique;
const designCreateMock = pm.salesSheetDesign.create;
const queryRawMock = pm.$queryRaw;

const ADMIN_SESSION = { id: "u1", email: "a@b.com", name: "Admin", role: "admin" };
const WRITE_PERMS = [{ resource: "property", action: "write", granted: true }];

const ctx = { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) };
const req = (body: unknown) =>
  new Request("http://localhost:3000/api/properties/x/sales-sheets/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** $queryRaw のタグ付きテンプレート呼び出しを文字列化(SQL文のFROM句等を確認する用)。 */
function sqlOf(call: unknown[]): string {
  return (call[0] as string[]).join("?");
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue(ADMIN_SESSION);
  (getUserPermissions as Mock).mockResolvedValue(WRITE_PERMS);
  propertyFindMock.mockResolvedValue(baseProperty);
  pm.propertyOwner.findFirst.mockResolvedValue(null);
  pm.propertyPhoto.findMany.mockResolvedValue([]);
  designCreateMock.mockResolvedValue({ id: "sheet-1" });
  updateManyMock.mockResolvedValue({ count: 1 });
  buildingUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe("POST /sales-sheets/new — 物件への保存", () => {
  it("既定(チェックON)で変わった欄だけ物件を更新し、変更履歴を1欄1行残す", async () => {
    const res = await POST(req({ price: "3480", access: "○○線 徒歩8分", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyWriteback).toEqual({ saved: ["価格", "交通"], unreadable: [], conflict: false });
    // C1: 書き込み条件に version を付ける(updateMany)。property.updateMany は1回・ChangeLog は2行。
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: baseProperty.id, version: 1 },
      data: { salePrice: 3480, access: "○○線 徒歩8分", version: { increment: 1 } },
    });
    // I3: ChangeLog の中身(targetTable/source/changedBy/fieldName/oldValue/newValue)を固定する。
    const logs = changeLogCreateManyMock.mock.calls[0][0].data;
    expect(logs).toHaveLength(2);
    expect(logs).toContainEqual({
      targetTable: "properties",
      targetId: baseProperty.id,
      fieldName: "salePrice",
      oldValue: null,
      newValue: "3480",
      source: "manual",
      changedBy: "u1",
    });
    expect(logs).toContainEqual({
      targetTable: "properties",
      targetId: baseProperty.id,
      fieldName: "access",
      oldValue: null,
      newValue: "○○線 徒歩8分",
      source: "manual",
      changedBy: "u1",
    });
  });

  it("チェックOFFなら物件を更新しない", async () => {
    const res = await POST(req({ price: "3480", saveToProperty: false }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback).toEqual({ saved: [], unreadable: [], conflict: false });
  });

  it("読み取れない値は保存せず知らせに出す", async () => {
    const res = await POST(req({ price: "応談", propertyVersion: 1 }), ctx);
    const json = await res.json();
    expect(json.propertyWriteback.saved).toEqual([]);
    expect(json.propertyWriteback.unreadable).toEqual(["価格"]);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  // C2/I6: 現行クライアントは version を送らない(Task 5 で送るようになる)。無条件で
  // 上書きせず、conflict 扱いにして物件へは書かない(図面自体は作る)。
  it("propertyVersion を送らないと conflict 扱いで書き込まない(C2)", async () => {
    const res = await POST(req({ price: "3480" }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback).toEqual({ saved: [], unreadable: [], conflict: true });
    expect(designCreateMock).toHaveBeenCalledTimes(1);
  });

  it("propertyVersion が数値でないと conflict 扱いで書き込まない(C2)", async () => {
    const res = await POST(req({ price: "3480", propertyVersion: "4" }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback.conflict).toBe(true);
  });

  it("棟がある物件で buildingVersion を送らないと conflict 扱い(C2)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseMansion, building: testBuilding });
    const res = await POST(req({ structure: "RC", propertyVersion: 1 }), ctx); // buildingVersion 省略
    expect(res.status).toBe(201);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(buildingUpdateManyMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback.conflict).toBe(true);
  });

  // C1: version 判定・差分は「ロック前の最初の読み取り」ではなく「ロック後に読み直した値」
  // を基準にすること。最初の読み取りが(たまたま)クライアントの propertyVersion と一致して
  // いても、ロック後の読み直しが別の値なら衝突として検知できなければならない。
  it("ロック前に読んだ版ではなく、ロック後に読み直した版で conflict を判定する(C1)", async () => {
    propertyFindMock
      .mockResolvedValueOnce({ ...baseProperty, version: 4 }) // 最初の読み取り(ロック前)
      .mockResolvedValueOnce({ ...baseProperty, version: 5 }); // ロック後の読み直し(他の人が先に更新済み)
    const res = await POST(req({ price: "3480", propertyVersion: 4 }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback.conflict).toBe(true);
    expect(designCreateMock).toHaveBeenCalledTimes(1);
  });

  // ⚠mansionOverridesSchema には RULES.mansion の "structure"/"totalFloors"/"totalUnits"
  // (to: building)キーが無い(=このルートからは書けない・schema のギャップは
  // task-4-report.md に記録)。schema にある建物向けキーは basementFloors と
  // builtYearMonth のみのため、これで「区分は棟へ保存する」を確認する。
  it("区分は棟へ保存する(basementFloors/builtYearMonth→棟)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseMansion, building: testBuilding });
    const res = await POST(
      req({ basementFloors: "2", builtYearMonth: "2015年3月", propertyVersion: 1, buildingVersion: 1 }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(buildingUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(buildingUpdateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: "b1", version: 1 },
      data: { basementFloors: 2, builtYear: 2015, builtMonth: 3, version: { increment: 1 } },
    });
    // I3: 棟側の ChangeLog(targetTable: "buildings")も固定する。
    const logs = changeLogCreateManyMock.mock.calls[0][0].data;
    expect(logs).toContainEqual({
      targetTable: "buildings",
      targetId: "b1",
      fieldName: "basementFloors",
      oldValue: null,
      newValue: "2",
      source: "manual",
      changedBy: "u1",
    });
    expect(logs).toContainEqual({
      targetTable: "buildings",
      targetId: "b1",
      fieldName: "builtYear",
      oldValue: null,
      newValue: "2015",
      source: "manual",
      changedBy: "u1",
    });
    expect(logs).toContainEqual({
      targetTable: "buildings",
      targetId: "b1",
      fieldName: "builtMonth",
      oldValue: null,
      newValue: "3",
      source: "manual",
      changedBy: "u1",
    });
  });

  // I4: 「一棟」kind(RULES.building に to:"building" のルールが無い)は、たとえ物件に
  // building relation が付いていても棟へは書かない、という保存先の仕分けそのものを見る。
  it("一棟は(棟が紐づいていても)棟へ保存しない", async () => {
    propertyFindMock.mockResolvedValue({
      ...baseProperty,
      propertyType: "apartment_building",
      building: testBuilding,
    });
    const res = await POST(req({ totalUnits: "12", propertyVersion: 1, buildingVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(buildingUpdateManyMock).not.toHaveBeenCalled();
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({ totalUnits: 12 });
  });

  it("保存の途中で失敗したら図面も作らない", async () => {
    updateManyMock.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ price: "3480", propertyVersion: 1 }), ctx);
    // 単体テストの prisma mock は実トランザクションを張らないため巻き戻りそのものは
    // 検証できない(原子性は「1つの $transaction にまとめてある」ことで担保し、レビューで
    // 確認する)。ここでは応答が 500 であることだけを確かめる。
    expect(res.status).toBe(500);
  });

  // I2: $transaction を外しても(=図面作成と物件更新が別々の呼び出しになっても)このテストが
  // 緑のままにならないよう、$transaction 自体が使われていること・createDesign に渡された tx
  // が物件更新にも使われている(同じ prisma mock)ことを固定する。
  it("図面作成と物件更新は同じトランザクション(tx)の中で行われる", async () => {
    const res = await POST(req({ price: "3480", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    const txPassedToCreateDesign = (createDesign as Mock).mock.calls[0][1];
    expect(txPassedToCreateDesign).toBe(pm);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  // I5: FOR UPDATE でロックしてから更新すること(呼び出し順)を固定する。区分は棟の行も
  // 先にロックする。
  it("FOR UPDATE で物件(区分は棟も)をロックしてから更新する", async () => {
    propertyFindMock.mockResolvedValue({ ...baseMansion, building: testBuilding });
    const res = await POST(
      req({ price: "3480", basementFloors: "2", propertyVersion: 1, buildingVersion: 1 }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(sqlOf(queryRawMock.mock.calls[0])).toMatch(/FROM properties/);
    expect(sqlOf(queryRawMock.mock.calls[0])).toMatch(/FOR UPDATE/);
    expect(sqlOf(queryRawMock.mock.calls[1])).toMatch(/FROM buildings/);
    expect(sqlOf(queryRawMock.mock.calls[1])).toMatch(/FOR UPDATE/);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(buildingUpdateManyMock).toHaveBeenCalledTimes(1);
    const lastLockOrder = Math.max(...queryRawMock.mock.invocationCallOrder);
    expect(lastLockOrder).toBeLessThan(updateManyMock.mock.invocationCallOrder[0]);
    expect(lastLockOrder).toBeLessThan(buildingUpdateManyMock.mock.invocationCallOrder[0]);
  });

  // I1: writeback は zod 検証済みの overrides を使う。schema に無いキーは無検証で
  // 列へ入らないこと。⚠R14 で exclusiveArea/balconyArea/layout/balconyDir/floorNo/
  // managementFee/repairFee は schema に追加した(区分の書き戻し・下のテスト参照)ため、
  // この題材には使えない。`structure`(→building.structureType)は既存の意図的な設計
  // (自動反映専用・上書き機構を持たない)により schema に無いままなので、これで確かめる。
  it("schema に無いキー(structure)は無検証で保存されない(I1)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseMansion, building: testBuilding });
    const res = await POST(req({ structure: "RC", propertyVersion: 1, buildingVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(buildingUpdateManyMock).not.toHaveBeenCalled();
    expect((await res.json()).propertyWriteback).toEqual({ saved: [], unreadable: [], conflict: false });
  });

  // R14: 区分マンションの物件側7項目(仕様書 §4.4)。mansionOverridesSchema に無かった
  // ため書き戻し経路から到達不能になっていたギャップの修正確認。
  it("区分で exclusiveArea と managementFee を送ると物件に保存される(R14)", async () => {
    propertyFindMock.mockResolvedValue(baseMansion);
    const res = await POST(
      req({ exclusiveArea: "62.45", managementFee: "12000", propertyVersion: 1 }),
      ctx,
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyWriteback).toEqual({ saved: ["専有面積", "管理費"], unreadable: [], conflict: false });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: baseProperty.id, version: 1 },
      data: { exclusiveArea: 62.45, managementFee: 12000, version: { increment: 1 } },
    });
    const logs = changeLogCreateManyMock.mock.calls[0][0].data;
    expect(logs).toContainEqual({
      targetTable: "properties",
      targetId: baseProperty.id,
      fieldName: "exclusiveArea",
      oldValue: null,
      newValue: "62.45",
      source: "manual",
      changedBy: "u1",
    });
    expect(logs).toContainEqual({
      targetTable: "properties",
      targetId: baseProperty.id,
      fieldName: "managementFee",
      oldValue: null,
      newValue: "12000",
      source: "manual",
      changedBy: "u1",
    });
  });

  it("区分で layout を送ると layoutType に入る(R14)", async () => {
    propertyFindMock.mockResolvedValue(baseMansion);
    const res = await POST(req({ layout: "3LDK", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({ layoutType: "3LDK" });
    expect((await res.json()).propertyWriteback.saved).toEqual(["間取り"]);
  });
});
