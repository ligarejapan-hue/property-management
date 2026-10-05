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
    property: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    building: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
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
import { POST } from "../../app/api/import/csv/route";
import { areaKey, buildingNameKey } from "@/lib/building-identity";

const pm = prisma as unknown as {
  $transaction: Mock;
  importJob: { create: Mock; update: Mock };
  importJobRow: { create: Mock };
  property: { findMany: Mock; findUnique: Mock; create: Mock; update: Mock };
  building: { findMany: Mock; findUnique: Mock; create: Mock };
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
    expect(applyBuildingLinkMock.mock.calls[0][1]).toMatchObject({ propertyId: "p1", choice: { kind: "auto" }, currentBuildingId: null });
    expect(applyBuildingLinkMock.mock.calls[1][1]).toMatchObject({ propertyId: "p2", choice: { kind: "existing", buildingId: "b1" } });
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
