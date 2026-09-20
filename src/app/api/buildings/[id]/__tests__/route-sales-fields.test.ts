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
    building: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { PATCH } from "../route";

type PrismaMock = {
  building: { findUnique: Mock; update: Mock };
};
const pm = prisma as unknown as PrismaMock;
const buildingUpdateMock = pm.building.update;

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

function patchRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/buildings/b1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callPatch(body: Record<string, unknown>) {
  return PATCH(patchRequest(body) as never, {
    params: Promise.resolve({ id: "b1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pm.building.findUnique.mockResolvedValue(EXISTING_BUILDING);
  pm.building.update.mockResolvedValue({ ...EXISTING_BUILDING, id: "b1" });
});

describe("PATCH /api/buildings/[id] — 築月・地下階(F3 Task8)", () => {
  it("築月・地下階を更新できる", async () => {
    const res = await callPatch({ builtMonth: 3, basementFloors: 1 });

    expect(res.status).toBe(200);
    expect(buildingUpdateMock.mock.calls[0][0].data).toMatchObject({
      builtMonth: 3,
      basementFloors: 1,
    });
  });

  it("月は1〜12だけ受け付ける", async () => {
    const res = await callPatch({ builtMonth: 13 });

    expect(res.status).toBe(422);
    expect(buildingUpdateMock).not.toHaveBeenCalled();
  });

  it("地下階は0以上だけ受け付ける", async () => {
    const res = await callPatch({ basementFloors: -1 });

    expect(res.status).toBe(422);
    expect(buildingUpdateMock).not.toHaveBeenCalled();
  });
});
