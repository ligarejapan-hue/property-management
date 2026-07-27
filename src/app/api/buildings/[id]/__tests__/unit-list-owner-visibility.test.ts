import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// 棟の部屋一覧 GET /api/buildings/[id]/properties の PII ゲート
// （総点検 2026-07-27 P1-2）。
//
// この route は property:read だけを確認して propertyOwners.owner.name を
// 生値で返しており、owner:read ゲートも表示レベル（マスク/非表示）も
// field_staff の担当スコープも通っていなかった。物件一覧 API
// (/api/properties) は同じ氏名を maskValue で伏せるため、棟経由だけが
// 抜け道になっていた（UI: buildings/[id]/page.tsx が owner.name を描画）。
//
// 参照: src/lib/property-access.ts（個別物件 API と同じ record スコープ）

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
  apiResponse: vi.fn((body: unknown, status = 200) =>
    Response.json(body as object, { status }),
  ),
  handleApiError: vi.fn(
    (e: { status?: number; message?: string; code?: string }) =>
      Response.json(
        { error: { message: e?.message, code: e?.code } },
        { status: e?.status ?? 500 },
      ),
  ),
}));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    building: { findUnique: vi.fn() },
    property: { findMany: vi.fn(), create: vi.fn() },
  },
}));

import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/buildings/[id]/properties/route";

const req = new Request("http://localhost/x") as never;
const ctx = { params: Promise.resolve({ id: "bldg-1" }) };

/** permissions 配列（実物の hasPermission がそのまま解釈できる形）。 */
function perms(entries: Array<[string, string]>) {
  return entries.map(([resource, action]) => ({
    resource,
    action,
    granted: true,
  }));
}

function unit(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "unit-1",
    address: "東京都○○区 101",
    roomNo: "101",
    floorNo: 1,
    exclusiveArea: 50,
    layoutType: "2LDK",
    orientation: "南",
    occupancyStatus: "vacant",
    caseStatus: "new_case",
    registryStatus: "unconfirmed",
    createdBy: "other-user",
    assignedTo: null,
    propertyOwners: [{ owner: { id: "own-1", name: "山田太郎" } }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({
    id: "user-1",
    role: "office_staff",
  });
  (prisma.building.findUnique as unknown as Mock).mockResolvedValue({
    id: "bldg-1",
  });
  (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "full" });
});

async function body(res: Response) {
  return (await res.json()) as {
    data: Array<{ propertyOwners: Array<{ owner: { name: string | null } }> }>;
  };
}

describe("GET /api/buildings/[id]/properties — オーナー名の保護", () => {
  it("owner:read が無いユーザーには所有者を一切返さない", async () => {
    (getUserPermissions as Mock).mockResolvedValue(perms([["property", "read"]]));
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([unit()]);

    const res = await GET(req, ctx);
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data[0].propertyOwners).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("山田太郎");
  });

  it("表示レベルが masked のときは伏せ字にして返す", async () => {
    (getUserPermissions as Mock).mockResolvedValue(
      perms([
        ["property", "read"],
        ["owner", "read"],
      ]),
    );
    (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "masked" });
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([unit()]);

    const res = await GET(req, ctx);
    const json = await body(res);

    // maskValue("masked"): 4 文字以下は全伏せ (物件一覧 API と同じ関数)。
    expect(JSON.stringify(json)).not.toContain("山田太郎");
    expect(json.data[0].propertyOwners[0].owner.name).toBe("****");
  });

  it("表示レベルが masked の長い氏名は末尾4文字だけ残す（物件一覧と同一挙動）", async () => {
    (getUserPermissions as Mock).mockResolvedValue(
      perms([
        ["property", "read"],
        ["owner", "read"],
      ]),
    );
    (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "masked" });
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([
      unit({
        propertyOwners: [{ owner: { id: "own-2", name: "山田太郎左衛門" } }],
      }),
    ]);

    const res = await GET(req, ctx);
    const json = await body(res);

    expect(JSON.stringify(json)).not.toContain("山田太郎左衛門");
    expect(json.data[0].propertyOwners[0].owner.name).toBe("***郎左衛門");
  });

  it("表示レベルが hidden の所有者は一覧から落とす（null 名を描画しない）", async () => {
    (getUserPermissions as Mock).mockResolvedValue(
      perms([
        ["property", "read"],
        ["owner", "read"],
      ]),
    );
    (getOwnerDisplayConfig as Mock).mockResolvedValue({ name: "hidden" });
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([unit()]);

    const res = await GET(req, ctx);
    const json = await body(res);

    expect(json.data[0].propertyOwners).toEqual([]);
  });

  it("owner:read があり full なら従来どおり氏名を返す（退行防止）", async () => {
    (getUserPermissions as Mock).mockResolvedValue(
      perms([
        ["property", "read"],
        ["owner", "read"],
      ]),
    );
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([unit()]);

    const res = await GET(req, ctx);
    const json = await body(res);

    expect(json.data[0].propertyOwners[0].owner.name).toBe("山田太郎");
  });
});

describe("GET /api/buildings/[id]/properties — field_staff の担当スコープ", () => {
  it("担当外の部屋は返さない（作成者でも担当者でもない）", async () => {
    (getApiSession as Mock).mockResolvedValue({
      id: "user-1",
      role: "field_staff",
    });
    (getUserPermissions as Mock).mockResolvedValue(
      perms([
        ["property", "read"],
        ["owner", "read"],
      ]),
    );
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([
      unit({ id: "mine-created", createdBy: "user-1" }),
      unit({ id: "mine-assigned", createdBy: "x", assignedTo: "user-1" }),
      unit({ id: "not-mine", createdBy: "x", assignedTo: "y" }),
    ]);

    const res = await GET(req, ctx);
    const json = (await res.json()) as { data: Array<{ id: string }> };

    expect(json.data.map((d) => d.id)).toEqual([
      "mine-created",
      "mine-assigned",
    ]);
  });

  it("office_staff は全部屋を見られる（退行防止）", async () => {
    (getUserPermissions as Mock).mockResolvedValue(
      perms([
        ["property", "read"],
        ["owner", "read"],
      ]),
    );
    (prisma.property.findMany as unknown as Mock).mockResolvedValue([
      unit({ id: "a" }),
      unit({ id: "b" }),
    ]);

    const res = await GET(req, ctx);
    const json = (await res.json()) as { data: Array<{ id: string }> };

    expect(json.data.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
