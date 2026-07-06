import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// GET /api/properties/[id] の building select 拡張を検証する（@codex P2 fix）。
//
// 売マンション作成ダイアログの自動反映プレビュー（構造/地上階/総戸数/管理会社・
// 築年月ヒント）は building.structureType/totalFloors/totalUnits/managementCompany/
// builtYear を読むが、本 route の Prisma select が id/name だけだったため常に空欄に
// なっていた（生成される図面自体は new/route.ts が building から直接同じ列を fetch
// しており正しい値が入る＝ズレていたのはダイアログのプレビューだけ）。
//
// 1本目は「Prisma クエリが実際にこれらの列を select しているか」（この select 引数を
// 見ない限り、mock の返り値を検証するだけでは select 漏れを再現できず退行検知にならない）、
// 2本目は「select された値がレスポンスにそのまま素通りするか」を検証する。

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
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    property: { findUnique: vi.fn() },
    importJobRow: { findFirst: vi.fn() },
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "../route";

type PrismaMock = {
  property: { findUnique: Mock };
  importJobRow: { findFirst: Mock };
};
const pm = prisma as unknown as PrismaMock;

const BASE_PROPERTY = {
  id: "p1",
  createdBy: "u1",
  assignedTo: null,
  propertyOwners: [] as unknown[],
  photos: [] as unknown[],
  nextActions: [] as unknown[],
};

const SAMPLE_BUILDING = {
  id: "b1",
  name: "サンプルマンション",
  structureType: "RC",
  totalFloors: 10,
  totalUnits: 50,
  managementCompany: "サンプル管理株式会社",
  builtYear: 2015,
};

async function callGet(id = "p1") {
  const res = await GET(
    {} as unknown as Parameters<typeof GET>[0],
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.importJobRow.findFirst.mockResolvedValue(null);
});

describe("GET /api/properties/[id] — building 列の拡張(@codex P2)", () => {
  it("Prisma クエリの building select に structureType/totalFloors/totalUnits/managementCompany/builtYear を含める（既存 id/name は維持・追加のみ）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY, building: SAMPLE_BUILDING });

    await callGet();

    expect(pm.property.findUnique).toHaveBeenCalledTimes(1);
    const callArg = pm.property.findUnique.mock.calls[0][0] as {
      include: { building: { select: Record<string, unknown> } };
    };
    expect(callArg.include.building.select).toEqual({
      id: true,
      name: true,
      structureType: true,
      totalFloors: true,
      totalUnits: true,
      managementCompany: true,
      builtYear: true,
    });
  });

  it("レスポンスの building に structureType/totalFloors/totalUnits/managementCompany/builtYear がそのまま含まれる（作成ダイアログの自動反映プレビューが読む列）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY, building: SAMPLE_BUILDING });

    const { status, body } = await callGet();

    expect(status).toBe(200);
    expect(body.building).toEqual(SAMPLE_BUILDING);
  });

  it("building の無い物件（土地など）は building:null のまま（既存挙動を破壊しない）", async () => {
    pm.property.findUnique.mockResolvedValue({ ...BASE_PROPERTY, building: null });

    const { body } = await callGet();
    expect(body.building).toBeNull();
  });
});
