import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/buildings/[id]/photos/[photoId] の「代表にする」。
// 物件の写真と同じ穴(他の代表を外す/この写真を代表にするがトランザクション外の2文)。
// 「tx 開始 → 親の棟の行を FOR UPDATE → 子の行」に揃えて同じ棟の切り替えを直列にする。

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
  apiResponse: vi.fn((body: unknown, status = 200) => Response.json(body as object, { status })),
  handleApiError: vi.fn((e: { status?: number; message?: string; code?: string }) =>
    Response.json({ error: { message: e?.message, code: e?.code } }, { status: e?.status ?? 500 }),
  ),
}));
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
// ⚠lockBuildingRow(棟の行の FOR UPDATE)は実装のまま使う。
vi.mock("@/lib/prisma", () => ({
  default: {
    buildingPhoto: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { PATCH } from "../route";

type PrismaMock = {
  buildingPhoto: { findUnique: Mock; updateMany: Mock; update: Mock };
  $queryRaw: Mock;
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const BUILDING = "33333333-3333-4333-8333-333333333333";
const PHOTO = "44444444-4444-4444-8444-444444444444";

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/buildings/${BUILDING}/photos/${PHOTO}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof PATCH>[0],
    { params: Promise.resolve({ id: BUILDING, photoId: PHOTO }) },
  );

let calls: string[];
let lockSql: string;
let tx: {
  $queryRaw: Mock;
  buildingPhoto: { updateMany: Mock; update: Mock };
};

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  lockSql = "";
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue({});
  pm.buildingPhoto.findUnique.mockResolvedValue({ id: PHOTO, buildingId: BUILDING });
  tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      calls.push("lock");
      lockSql = strings.join("?");
      return [{ id: BUILDING }];
    }),
    buildingPhoto: {
      updateMany: vi.fn(async () => {
        calls.push("clearOthers");
        return { count: 1 };
      }),
      update: vi.fn(async () => {
        calls.push("update");
        return { id: PHOTO, isPrimary: true };
      }),
    },
  };
  pm.$transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
});

describe("PATCH 代表にする(同時に押しても代表は1枚)", () => {
  it("棟の行を押さえてから、他の代表を外し、この写真を代表にする(同じトランザクション)", async () => {
    const res = await patch({ isPrimary: true });

    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["lock", "clearOthers", "update"]);
    expect(lockSql).toMatch(/FROM buildings WHERE id = \?::uuid FOR UPDATE/);
    expect(tx.buildingPhoto.updateMany).toHaveBeenCalledWith({
      where: { buildingId: BUILDING, id: { not: PHOTO }, isPrimary: true },
      data: { isPrimary: false },
    });
    expect(pm.buildingPhoto.updateMany).not.toHaveBeenCalled();
    expect(pm.buildingPhoto.update).not.toHaveBeenCalled();
  });

  it("キャプションだけの更新では他の写真に触らない(ロックは取る)", async () => {
    const res = await patch({ caption: "外観" });

    expect(res.status).toBe(200);
    expect(calls).toEqual(["lock", "update"]);
    expect(tx.buildingPhoto.updateMany).not.toHaveBeenCalled();
  });
});
