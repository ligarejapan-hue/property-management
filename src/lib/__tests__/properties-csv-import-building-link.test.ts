/**
 * POST /api/import/csv — 区分の棟の解決とつなぎ(設計 2026-10-04 §4.4)。
 *
 * - Review Focus 4: 同じ取込で同じ新しい建物が続けて出てくると、1行目で作った棟に2行目がつながる
 *   (「作る」の結果を覚えない)。
 * - 名前の部分一致が1件だけでも黙ってつながず、要確認(候補つき)に回す(発注者承認の方針変更)。
 *
 * prisma は全面モック(棟の表は配列の偽物)。applyBuildingLink は偽物で、auto のとき棟を作って配列へ足す。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
  class MockNextResponse extends Response {}
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse };
});

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
      if (typeof e?.status === "number") {
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

vi.mock("@/lib/change-log", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/change-log")>();
  return { ...actual, recordChanges: vi.fn() };
});

// 物件の作成と棟へのつなぎは1つのトランザクション(tx は同じ偽物を渡す)。
vi.mock("@/lib/prisma", () => {
  const db: Record<string, unknown> = {
    importJob: { create: vi.fn(), update: vi.fn() },
    importJobRow: { create: vi.fn() },
    property: {
      findMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
    },
    building: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    $executeRaw: vi.fn(),
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { default: db };
});

const applyBuildingLinkMock = vi.fn();
const writeBuildingLinkAuditMock = vi.fn();
vi.mock("@/lib/building-link/apply", () => ({
  applyBuildingLink: (...a: unknown[]) => applyBuildingLinkMock(...a),
  writeBuildingLinkAudit: (...a: unknown[]) => writeBuildingLinkAuditMock(...a),
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { recordChanges } from "@/lib/change-log";
import { POST } from "../../app/api/import/csv/route";
import { areaKey, buildingNameKey } from "@/lib/building-identity";

const pm = prisma as unknown as {
  $transaction: Mock;
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  property: { findMany: Mock; findUnique: Mock; findUniqueOrThrow: Mock; create: Mock; update: Mock; updateMany: Mock };
  building: { findMany: Mock; findUnique: Mock; create: Mock; update: Mock };
};

const PERMS = [{ resource: "import", action: "write", granted: true }];

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/import/csv", {
    method: "POST",
    headers: { "content-type": "application/json" , "content-length": String(Buffer.byteLength(JSON.stringify(body))) },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

type FakeBuilding = {
  id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; createdAt: Date; units: number;
};
let buildings: FakeBuilding[] = [];
let propSeq = 0;

/** prisma の where を、resolveCsvBuilding が使う形だけ真似る。 */
function matches(b: FakeBuilding, where: Record<string, unknown>): boolean {
  if ("areaKey" in where) return b.areaKey === where.areaKey && b.nameKey === where.nameKey;
  if ("nameKey" in where) return b.nameKey === where.nameKey;
  const name = where.name as { contains?: string } | undefined;
  if (name?.contains !== undefined) return b.name.includes(name.contains);
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  buildings = [];
  propSeq = 0;
  vi.mocked(getApiSession).mockResolvedValue({ id: "user-1", email: "a@a", name: "A", role: "admin" } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS as never);
  pm.importJob.create.mockResolvedValue({ id: "job-1" });
  pm.importJob.update.mockResolvedValue({ id: "job-1" });
  pm.importJobRow.create.mockResolvedValue({ id: "row-1" });
  pm.property.findMany.mockResolvedValue([]);
  pm.building.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    buildings.filter((b) => matches(b, where)).map((b) => ({ ...b, _count: { properties: b.units } })),
  );
  pm.property.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `p${++propSeq}`,
    roomNo: null, buildingId: null, buildingNumber: null, buildingName: null,
    realEstateNumber: null, externalLinkKey: null,
    ...data,
  }));
  applyBuildingLinkMock.mockImplementation(async (_tx: unknown, input: {
    buildingName: string; address: string; choice: { kind: string; buildingId?: string };
  }) => {
    if (input.choice.kind === "existing") {
      const b = buildings.find((x) => x.id === input.choice.buildingId)!;
      b.units += 1;
      return { action: "linked", building: { id: b.id, name: b.name }, previousBuildingId: null, renamedFrom: null, warnings: [] };
    }
    const b: FakeBuilding = {
      id: `b${buildings.length + 1}`, name: input.buildingName, address: input.address,
      nameKey: buildingNameKey(input.buildingName), areaKey: areaKey(input.address), createdAt: new Date(), units: 1,
    };
    buildings.push(b);
    return { action: "created", building: { id: b.id, name: b.name }, previousBuildingId: null, renamedFrom: null, warnings: [] };
  });
});

describe("POST /api/import/csv — 区分の棟", () => {
  it("同じ新しい建物が2行続くと、1行目で作った棟に2行目がつながる(作った結果を覚えない)", async () => {
    const csv =
      "住所,マンション名,部屋番号\n" +
      "東京都大田区南雪谷1丁目164-2-45,新ビル,101\n" +
      "東京都大田区南雪谷1丁目164-2-46,新ビル,102\n";
    const res = await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number; needsReviewCount: number };
    expect(json).toMatchObject({ successCount: 2, needsReviewCount: 0 });
    expect(buildings).toHaveLength(1);
    expect(applyBuildingLinkMock).toHaveBeenCalledTimes(2);
    // importJobId: 取込が作った棟の目印を同じ tx で書くため(取り消しで空の棟を消す)。
    expect(applyBuildingLinkMock.mock.calls[0][1]).toMatchObject({ propertyId: "p1", choice: { kind: "auto" }, currentBuildingId: null, importJobId: "job-1" });
    expect(applyBuildingLinkMock.mock.calls[1][1]).toMatchObject({ propertyId: "p2", choice: { kind: "existing", buildingId: "b1" }, importJobId: "job-1" });
    // 物件は区分で、物件名を入れて作る。棟は apply がトランザクション内で入れる(create では入れない)。
    const first = pm.property.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(first).toMatchObject({ propertyType: "apartment_unit", buildingName: "新ビル" });
    expect(first.buildingId).toBeUndefined();
    expect(pm.$transaction).toHaveBeenCalledTimes(2);
    expect(writeBuildingLinkAuditMock).toHaveBeenCalledTimes(2);
  });

  it("名前の部分一致が1件だけでも、黙ってつながず要確認(候補つき)", async () => {
    buildings.push({
      id: "bx", name: "パークハイツ", address: "東京都港区六本木1丁目1",
      nameKey: buildingNameKey("パークハイツ"), areaKey: areaKey("東京都港区六本木1丁目1"), createdAt: new Date("2026-01-01"), units: 3,
    });
    const csv = "住所,マンション名,部屋番号\n東京都大田区南雪谷1丁目1-1,パーク,101\n";
    const res = await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    const json = (await res.json()) as { successCount: number; needsReviewCount: number };
    expect(json).toMatchObject({ successCount: 0, needsReviewCount: 1 });
    expect(pm.property.create).not.toHaveBeenCalled();
    expect(applyBuildingLinkMock).not.toHaveBeenCalled();
    const saved = pm.importJobRow.create.mock.calls[0][0].data as {
      status: string; errorMessage: string; rawData: Record<string, string>;
    };
    expect(saved.status).toBe("needs_review");
    expect(saved.errorMessage.startsWith("棟名")).toBe(true);
    expect(JSON.parse(saved.rawData.__building_candidates)).toEqual([
      { id: "bx", name: "パークハイツ", address: "東京都港区六本木1丁目1" },
    ]);
  });

  it("棟名の無い行は棟に触れない(apply を呼ばない)", async () => {
    const csv = "住所\n東京都大田区南雪谷1丁目1-1\n";
    const res = await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.property.create).toHaveBeenCalledTimes(1);
    expect(applyBuildingLinkMock).not.toHaveBeenCalled();
  });

  it("下見でつながる棟があっても、apply が棟に入れなかったら棟郵便番号を書かない(実際に入れた棟だけ)", async () => {
    buildings.push({
      id: "bz", name: "新ビル", address: "東京都大田区南雪谷1丁目1",
      nameKey: buildingNameKey("新ビル"), areaKey: areaKey("東京都大田区南雪谷1丁目1"), createdAt: new Date("2026-01-01"), units: 2,
    });
    applyBuildingLinkMock.mockResolvedValueOnce({
      action: "none", building: null, previousBuildingId: null, renamedFrom: null, warnings: [],
    });
    const csv = "住所,マンション名,部屋番号,棟郵便番号\n東京都大田区南雪谷1丁目1-1,新ビル,101,145-0066\n";
    const res = await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(applyBuildingLinkMock.mock.calls[0][1]).toMatchObject({ choice: { kind: "existing", buildingId: "bz" } });
    expect(pm.building.findUnique).not.toHaveBeenCalled();
  });
});

// 重複(不動産番号一致)=既存物件の更新でも、棟の解決を捨てない(@codex P2・2026-10-05)。
describe("POST /api/import/csv — 重複更新の区分の棟", () => {
  const ADDR = "東京都大田区南雪谷1丁目164-2-45";
  const base = {
    id: "px", address: ADDR, propertyType: "apartment_unit", roomNo: "101", buildingNumber: null,
    buildingId: null as string | null, buildingName: null as string | null,
    realEstateNumber: "RE-1", externalLinkKey: null, note: "old", registryStatus: "unconfirmed",
  };
  const setExisting = (over: Partial<typeof base> = {}) => {
    const existing = { ...base, ...over };
    pm.property.findMany.mockResolvedValue([
      { id: "px", address: ADDR, roomNo: "101", buildingId: existing.buildingId, realEstateNumber: "RE-1", externalLinkKey: null },
    ]);
    pm.property.findUnique.mockResolvedValue(existing);
    return existing;
  };
  const savedRow = () =>
    pm.importJobRow.create.mock.calls[0][0].data as { status: string; errorMessage: string | null; createdId: string | null };

  /** 取り消しが棟と物件名を戻せるよう、前の値を変更ログ(csv_import)に残す。 */
  const expectBuildingChangeLog = (
    oldV: { buildingId: string | null; buildingName: string | null },
    newV: { buildingId: string | null; buildingName: string | null },
  ) => {
    const arg = vi.mocked(recordChanges).mock.calls.at(-1)![0];
    expect(arg.source).toBe("csv_import");
    expect(arg.trackedFields).toEqual(expect.arrayContaining(["buildingId", "buildingName"]));
    expect(arg.oldValues).toMatchObject(oldV);
    expect(arg.newValues).toMatchObject(newV);
  };

  beforeEach(() => {
    pm.property.updateMany.mockResolvedValue({ count: 1 });
  });

  it("棟の無い区分の部屋は、更新と同じトランザクションで版番号を進めてから棟へつなぐ", async () => {
    const existing = setExisting();
    pm.property.findUniqueOrThrow
      .mockResolvedValueOnce({ ...existing, note: "新メモ" })
      .mockResolvedValue({ ...existing, note: "新メモ", buildingId: "b1", buildingName: "新ビル" });
    const csv = `住所,不動産番号,マンション名,部屋番号,備考\n${ADDR},RE-1,新ビル,101,新メモ\n`;
    const res = await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    expect(res.status).toBe(201);
    expect(pm.property.create).not.toHaveBeenCalled();
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    const upd = pm.property.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(upd.where).toMatchObject({ id: "px" });
    expect(upd.data).toMatchObject({ note: "新メモ", version: { increment: 1 } });
    expect(applyBuildingLinkMock).toHaveBeenCalledTimes(1);
    expect(applyBuildingLinkMock.mock.calls[0][1]).toMatchObject({
      propertyId: "px", propertyType: "apartment_unit", buildingName: "新ビル", choice: { kind: "auto" }, currentBuildingId: null,
      importJobId: "job-1",
    });
    // ロック順: 物件の行(版番号を進める更新)→ apply(アドバイザリロック)
    expect(pm.property.updateMany.mock.invocationCallOrder[0]).toBeLessThan(applyBuildingLinkMock.mock.invocationCallOrder[0]);
    expect(writeBuildingLinkAuditMock).toHaveBeenCalledWith("user-1", "px", expect.objectContaining({ action: "created" }), { importJobId: "job-1" });
    expect(savedRow()).toMatchObject({ status: "success", createdId: "px" });
    expect(savedRow().errorMessage).toContain("buildingId");
    expectBuildingChangeLog({ buildingId: null, buildingName: null }, { buildingId: "b1", buildingName: "新ビル" });
  });

  it("他の項目が変わらなくても、棟の無い部屋は版番号を進める更新を通してつなぐ", async () => {
    const existing = setExisting({ note: "同じ" });
    pm.property.findUniqueOrThrow
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ ...existing, buildingId: "b1", buildingName: "新ビル" });
    const csv = `住所,不動産番号,マンション名,部屋番号,備考\n${ADDR},RE-1,新ビル,101,同じ\n`;
    await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
    const upd = pm.property.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(upd.data).toEqual({ version: { increment: 1 } });
    expect(upd.where).toMatchObject({ id: "px", registryStatus: { not: "scheduled" } });
    expect(applyBuildingLinkMock).toHaveBeenCalledTimes(1);
    expect(savedRow()).toMatchObject({ status: "success", createdId: "px" });
    expect(savedRow().errorMessage).toContain("buildingId");
    expectBuildingChangeLog({ buildingId: null, buildingName: null }, { buildingId: "b1", buildingName: "新ビル" });
  });

  it("つながった部屋で CSV の棟名が比べる形で同じなら、棟も版番号もそのまま", async () => {
    buildings.push({
      id: "b9", name: "パークハウス第１", address: "東京都大田区南雪谷1丁目164",
      nameKey: buildingNameKey("パークハウス第１"), areaKey: areaKey(ADDR), createdAt: new Date("2026-01-01"), units: 1,
    });
    setExisting({ buildingId: "b0", buildingName: "パークハウス第一", note: "同じ" });
    const csv = `住所,不動産番号,マンション名,部屋番号,備考\n${ADDR},RE-1,パークハウス第１,101,同じ\n`;
    await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(applyBuildingLinkMock).not.toHaveBeenCalled();
    expect(savedRow()).toMatchObject({ status: "success", createdId: "px" });
    expect(savedRow().errorMessage).toContain("更新項目: なし");
  });

  it("棟の解決が要確認なら、重複更新でも従来どおり要確認(つながない・書かない)", async () => {
    buildings.push({
      id: "bx", name: "パークハイツ", address: "東京都港区六本木1丁目1",
      nameKey: buildingNameKey("パークハイツ"), areaKey: areaKey("東京都港区六本木1丁目1"), createdAt: new Date("2026-01-01"), units: 3,
    });
    setExisting();
    const csv = `住所,不動産番号,マンション名,部屋番号\n${ADDR},RE-1,パーク,101\n`;
    const res = await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
    const json = (await res.json()) as { needsReviewCount: number };
    expect(json.needsReviewCount).toBe(1);
    expect(pm.property.updateMany).not.toHaveBeenCalled();
    expect(applyBuildingLinkMock).not.toHaveBeenCalled();
    expect(savedRow().status).toBe("needs_review");
  });

  // 棟郵便番号は「この行の後に物件が実際につながっている棟」へ(@codex P2・2026-10-05)。
  //   同じ名前・同じ町丁目の棟が2つあり、解決は部屋数の多い B1 を選ぶが、部屋は B2 につながっていて
  //   付け替えない(planDuplicateBuildingLink=null)とき、B1 に書いてはいけない。
  describe("同名の棟が2つあるときの棟郵便番号", () => {
    const pushDupMasters = () => {
      for (const [id, units] of [["b1", 5], ["b2", 1]] as const) {
        buildings.push({
          id, name: "新ビル", address: "東京都大田区南雪谷1丁目164",
          nameKey: buildingNameKey("新ビル"), areaKey: areaKey(ADDR), createdAt: new Date("2026-01-01"), units,
        });
      }
      pm.building.findUnique.mockResolvedValue({ postalCode: null });
      pm.building.update.mockResolvedValue({});
    };

    it("項目の変更が無い行: 解決の B1 ではなく、部屋がつながっている B2 に書く", async () => {
      pushDupMasters();
      setExisting({ buildingId: "b2", buildingName: "新ビル", note: "同じ" });
      const csv = `住所,不動産番号,マンション名,部屋番号,備考,棟郵便番号\n${ADDR},RE-1,新ビル,101,同じ,145-0066\n`;
      await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
      expect(applyBuildingLinkMock).not.toHaveBeenCalled();
      expect(savedRow().errorMessage).toContain("更新項目: なし");
      expect(pm.building.update).toHaveBeenCalledTimes(1);
      expect(pm.building.update.mock.calls[0][0]).toMatchObject({ where: { id: "b2" }, data: { postalCode: "1450066" } });
    });

    it("項目が変わる行(トランザクションを通る): 付け替えないなら B2 に書く", async () => {
      pushDupMasters();
      const existing = setExisting({ buildingId: "b2", buildingName: "新ビル", note: "old" });
      pm.property.findUniqueOrThrow.mockResolvedValue({ ...existing, note: "新メモ" });
      const csv = `住所,不動産番号,マンション名,部屋番号,備考,棟郵便番号\n${ADDR},RE-1,新ビル,101,新メモ,145-0066\n`;
      await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
      expect(pm.property.updateMany).toHaveBeenCalledTimes(1);
      expect(applyBuildingLinkMock).not.toHaveBeenCalled();
      expect(pm.building.update).toHaveBeenCalledTimes(1);
      expect(pm.building.update.mock.calls[0][0]).toMatchObject({ where: { id: "b2" } });
    });

    it("区分でない既存物件(棟につながず・つながってもいない)なら、どの棟にも書かない", async () => {
      pushDupMasters();
      setExisting({ propertyType: "land", buildingId: null, buildingName: null, note: "同じ" });
      const csv = `住所,不動産番号,マンション名,部屋番号,備考,棟郵便番号\n${ADDR},RE-1,新ビル,101,同じ,145-0066\n`;
      await POST(makeRequest({ fileName: "a.csv", csvText: csv }));
      expect(applyBuildingLinkMock).not.toHaveBeenCalled();
      expect(pm.building.update).not.toHaveBeenCalled();
    });
  });
});
