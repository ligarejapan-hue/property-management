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

/**
 * createDesign(実装は薄いモックだが document 自体は build-document.ts の実関数で組む)
 * に渡された document から、スペック表(footer-* を除く table 要素)の行を label で引く。
 * R16: 図面と物件が同じ入力から作られることを確認するのに使う。
 */
function documentTableRow(label: string): string | undefined {
  const doc = (createDesign as Mock).mock.calls[0][0].document as {
    elements: { type: string; id?: string; rows?: { label: string; value: string }[] }[];
  };
  for (const el of doc.elements) {
    if (el.type === "table" && !el.id?.startsWith("footer-")) {
      const r = el.rows?.find((row) => row.label === label);
      if (r) return r.value;
    }
  }
  return undefined;
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

  // [Task10 I-1] 範囲外/非整数の値(DECIMAL/INT列の桁・範囲を超える)を Prisma へそのまま
  // 渡すと Postgres が例外を投げ、トランザクションが巻き戻って図面ごと作成が500で失敗する
  // 不具合の修正確認。「その欄だけ保存しない」に倒し、図面の作成自体は成功させる。
  it("範囲外・非整数の値はその欄だけ保存せず、図面の作成自体は成功する(500にならない)", async () => {
    const res = await POST(
      req({ landArea: "1000000000", access: "○○線 徒歩8分", propertyVersion: 1 }),
      ctx,
    );
    expect(res.status).toBe(201); // 500にならない
    const json = await res.json();
    expect(json.propertyWriteback.unreadable).toEqual(["土地面積"]);
    expect(json.propertyWriteback.saved).toEqual(["交通"]);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).not.toHaveProperty("landArea");
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({ access: "○○線 徒歩8分" });
    expect(designCreateMock).toHaveBeenCalledTimes(1); // 図面自体は作られる
  });

  it("階数が非整数(3.5)ならその欄だけ保存せず、図面の作成自体は成功する(500にならない)(戸建)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseProperty, propertyType: "house" });
    const res = await POST(req({ aboveFloors: "3.5", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.propertyWriteback.unreadable).toEqual(["地上階"]);
    expect(json.propertyWriteback.saved).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(designCreateMock).toHaveBeenCalledTimes(1);
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

  // @codex P1: ロックする棟を「トランザクションに入る前に読んだ property.building.id」で
  // 決めると、その間に別処理が building_id を張り替えたとき、古い棟をロックしたまま新しい棟を
  // 更新しうる(張り替えでは properties.version が上がらず、棟の version も一致しがち＝どちらの
  // 判定もすり抜ける)。棟のロックは「物件行を押さえた後の紐付け」を SQL 側で引き直して行う。
  it("棟のロックは古い building.id を使わず、物件の現在の紐付けから引く(@codex P1)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseMansion, building: testBuilding });
    const res = await POST(req({ basementFloors: "2", propertyVersion: 1, buildingVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    const buildingLock = queryRawMock.mock.calls[1];
    expect(sqlOf(buildingLock)).toMatch(/JOIN properties/);
    expect(sqlOf(buildingLock)).toMatch(/FOR UPDATE OF b/);
    // 埋め込む値は物件 id のみ。ロック前に読んだ棟 id("b1")は使わない。
    expect(buildingLock.slice(1)).toEqual(["11111111-1111-1111-1111-111111111111"]);
    expect(buildingLock.slice(1)).not.toContain(testBuilding.id);
  });

  // 同じ理由の裏返し: ロック前の読み取りで棟が無く見えても、押さえた後に紐付いていれば
  // ロックが要る。棟ロックの SQL は紐付きの有無で分岐させず必ず流す(無ければ0行)。
  it("ロック前の読み取りで棟が無くても、棟ロックのSQLは流す(@codex P1)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseProperty, building: null });
    const res = await POST(req({ price: "3480", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(sqlOf(queryRawMock.mock.calls[1])).toMatch(/FROM buildings/);
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

  // R16: buildMansionValues(build-document.ts)が override を読まず常に property の
  // 自動反映値を使っていたため、「物件には新しい値が保存されるが、同じリクエストで
  // 作られる図面には物件の古い値が出る」というズレがあった。図面(document)と物件
  // (property.updateMany)が同じ入力から作られる(=一致する)ことをこのテストで固定する。
  it("区分で exclusiveArea を送ると、図面にその値が出て物件にも同じ値が保存される(R16)", async () => {
    // 物件の「古い値」は 65.00。作成画面で 67.21 を入力する想定。
    propertyFindMock.mockResolvedValue({ ...baseMansion, exclusiveArea: "65.00" });
    const res = await POST(req({ exclusiveArea: "67.21", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    // 図面: 入力値(67.21)が出る。物件の古い値(65.00)ではない。
    expect(documentTableRow("専有面積")).toBe("67.21㎡");
    // 物件: 同じ入力値(数値化した 67.21)が保存される。
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({ exclusiveArea: 67.21 });
  });

  it("区分で exclusiveArea を送らなければ、図面は従来どおり物件の値を使う(R16)", async () => {
    propertyFindMock.mockResolvedValue({ ...baseMansion, exclusiveArea: "65.00" });
    const res = await POST(req({ propertyVersion: 1 }), ctx); // exclusiveArea 省略
    expect(res.status).toBe(201);
    expect(documentTableRow("専有面積")).toBe("65.00㎡");
    expect(updateManyMock).not.toHaveBeenCalled(); // 差分が無いので書き戻しも起きない
  });

  it("区分で layout を送ると layoutType に入る(R14)", async () => {
    propertyFindMock.mockResolvedValue(baseMansion);
    const res = await POST(req({ layout: "3LDK", propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({ layoutType: "3LDK" });
    expect((await res.json()).propertyWriteback.saved).toEqual(["間取り"]);
  });
});

// [Task10 C-1] 最初の findUnique(document組み立て用)の select に F3 の16列(+棟の
// builtMonth/basementFloors)が入っていなかったため、1枚目の図面で物件に保存した値が
// 2枚目の図面には一度も出てこなかった(document は常に空欄)。この describe は select と
// build-document.ts への受け渡しが一続きで動くことを route レベルで確認する
// (buildXxxValues 自体の詳細な優先順位は build-land/house/building/mansion.test.ts)。
describe("POST /sales-sheets/new — 図面への読み戻し(C-1)", () => {
  it("土地: 物件に保存済みの価格・交通・土地面積が図面に出る", async () => {
    propertyFindMock.mockResolvedValue({
      ...baseProperty,
      salePrice: 3480,
      access: "○○線 徒歩8分",
      landArea: "150.5",
      landAreaMethod: "実測",
    });
    const res = await POST(req({ propertyVersion: 1 }), ctx); // override 無し
    expect(res.status).toBe(201);
    const doc = (createDesign as Mock).mock.calls[0][0].document as {
      elements: { id: string; content?: string }[];
    };
    expect(doc.elements.find((e) => e.id === "price")).toMatchObject({ content: "3,480万円" });
    expect(documentTableRow("交通")).toBe("○○線 徒歩8分");
    expect(documentTableRow("土地面積")).toBe("150.5㎡（実測）");
  });

  it("戸建: 物件に保存済みの構造・地上階・築年月が図面に出る", async () => {
    propertyFindMock.mockResolvedValue({
      ...baseProperty,
      propertyType: "house",
      structureType: "木造",
      aboveFloors: 2,
      builtYear: 2010,
      builtMonth: 5,
    });
    const res = await POST(req({ propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(documentTableRow("構造・階数")).toBe("木造 / 地上2階");
    expect(documentTableRow("築年月")).toBe("2010年5月");
  });

  it("一棟: 物件に保存済みの総戸数・想定利回りが図面に出る", async () => {
    propertyFindMock.mockResolvedValue({
      ...baseProperty,
      propertyType: "apartment_building",
      totalUnits: 12,
      grossYield: "7.8",
    });
    const res = await POST(req({ propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(documentTableRow("総戸数")).toBe("12戸");
    expect(documentTableRow("想定利回り")).toBe("7.8％");
  });

  it("区分マンション: 棟に保存済みのbuiltMonthが「◯年◯月」の形で図面に出る", async () => {
    propertyFindMock.mockResolvedValue({
      ...baseMansion,
      building: { ...testBuilding, builtYear: 2008, builtMonth: 3 },
    });
    const res = await POST(req({ propertyVersion: 1 }), ctx);
    expect(res.status).toBe(201);
    expect(documentTableRow("築年月")).toBe("2008年3月");
  });

  // [Task10 mansion readback fix] 区分マンションのみ price/tax/taxAmount/access/parking が
  // buildMansionValues 側の override 固定(o.x のみ)で、1枚目の図面作成でbuildWriteback が
  // property へ保存した値が2枚目の図面(この POST)に一度も出てこなかった。土地/戸建/一棟と
  // 同じ read-back を区分マンションにも適用したことの route レベルの確認
  // (select→buildSaleMansionDocument の受け渡しが一続きで動くこと)。
  it("区分マンション: 物件に保存済みの価格・交通・駐車場が図面に出る", async () => {
    propertyFindMock.mockResolvedValue({
      ...baseMansion,
      salePrice: 6590,
      saleTaxType: "課税",
      saleTaxAmount: 300,
      access: "JR中央線 西荻窪駅 徒歩8分",
      parking: "有",
    });
    const res = await POST(req({ propertyVersion: 1 }), ctx); // override 無し
    expect(res.status).toBe(201);
    const doc = (createDesign as Mock).mock.calls[0][0].document as {
      elements: { id: string; content?: string }[];
    };
    expect(doc.elements.find((e) => e.id === "price")).toMatchObject({ content: "6,590万円" });
    expect(documentTableRow("交通")).toBe("JR中央線 西荻窪駅 徒歩8分");
    expect(documentTableRow("うち消費税")).toBe("300万円");
  });
});
