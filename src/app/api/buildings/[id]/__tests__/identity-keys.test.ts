import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/buildings/[id] に「築月」「地下階」を足せることを固定する(F3 Task8)。
// 物件・棟に販売条件の列を足す migration(F3 Task3)で Building.builtMonth /
// Building.basementFloors が追加済み。zod の受け口に無いと黙って無視される
// (棟編集画面から直しても保存されない)ため、まずここで固定する。
//
// mock の作り方は同フォルダの unit-list-owner-visibility.test.ts に合わせる。

const mockSession = { id: "user-1" };

// ⚠api-helpers を vi.importActual すると実物の "@/lib/auth" まで読み込まれ、next-auth
//   内部の拡張子なし "next/server" import が node の ESM 解決に失敗する
//   (src/app/api/import/paste/commit/__tests__/route.test.ts と同じ回避)。
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// リポジトリ内の route テスト全てが NextRequest/NextResponse をこの形で mock している。
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

// 実物の apiResponse/handleApiError を使う(zod の検証エラーが 422 になることを
// このテストで確かめたいため、api-helpers 全体は差し替えずセッション/権限だけ被せる)。
vi.mock("@/lib/api-helpers", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-helpers")>(
      "@/lib/api-helpers",
    );
  return {
    ...actual,
    getApiSession: vi.fn(async () => mockSession),
    getUserPermissions: vi.fn(async () => []),
  };
});
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({
  recordChanges: vi.fn(),
  BUILDING_TRACKED_FIELDS: [],
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    building: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { PATCH } from "../route";

type PrismaMock = {
  building: { findUnique: Mock; update: Mock; updateMany: Mock };
};
const pm = prisma as unknown as PrismaMock;
const buildingUpdateMock = pm.building.updateMany;

const EXISTING_BUILDING = {
  id: "b1",
  version: 1,
  name: "サンプルマンション",
  address: "東京都○○区1-1-1",
  postalCode: "100-0001",
  lotNumber: "1番1",
  realEstateNumber: null,
  totalFloors: 10,
  totalUnits: 50,
  builtYear: 2015,
  builtMonth: null,
  structureType: "RC",
  managementCompany: "サンプル管理株式会社",
  basementFloors: null,
  gpsLat: null,
  gpsLng: null,
  note: null,
};

async function callPatch(body: Record<string, unknown>) {
  return PATCH(
    new Request("http://localhost:3000/api/buildings/b1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, ...body }),
    }) as never,
    { params: Promise.resolve({ id: "b1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.building.findUnique.mockResolvedValue(EXISTING_BUILDING);
  pm.building.updateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/buildings/[id] — 比べる形と町丁目(Task 5)", () => {
  it("名前を変えたら name_key と area_key を入れ直す", async () => {
    const res = await callPatch({ name: "パークハウス第二" });
    expect(res.status).toBe(200);
    expect(buildingUpdateMock.mock.calls[0][0].data).toMatchObject({
      name: "パークハウス第二",
      nameKey: "パ-クハウス第2",
      areaKey: expect.any(String),
    });
  });

  it("住所だけ変えても key を入れ直す(名前は既存のものから作る)", async () => {
    await callPatch({ address: "東京都港区芝1-2-3" });
    expect(buildingUpdateMock.mock.calls[0][0].data).toMatchObject({
      nameKey: "サンプルマンション",
      areaKey: expect.any(String),
    });
  });

  it("名前も住所も変えない保存では key を触らない", async () => {
    await callPatch({ note: "メモ" });
    const data = buildingUpdateMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("nameKey");
    expect(data).not.toHaveProperty("areaKey");
  });
});
