import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/properties/[id]/photos/[photoId] の「代表にする」。
// 以前は「他の写真の代表を外す」と「この写真を代表にする」がトランザクション外の
// 2文だったため、2人が別々の写真を同時に代表にすると代表が2枚になりえた。
// 物件配下の書き込み規約どおり「tx 開始 → 親の物件行を FOR UPDATE → 子の行」に
// 揃えれば、同じ物件の代表切り替えは直列になる(後から押した写真が代表)。

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
vi.mock("@/lib/property-access", () => ({ canAccessPropertyRecord: () => true }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
// ⚠lockPropertyRecordForWrite(親の物件行の FOR UPDATE)は実装のまま使う。
//   base client(pm)にも書き込み関数を置き、「tx ではなく base client で書く」回帰を
//   「呼ばれていない」の形で拾う。
vi.mock("@/lib/prisma", () => ({
  default: {
    propertyPhoto: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { PATCH } from "../route";

type PrismaMock = {
  propertyPhoto: { findUnique: Mock; updateMany: Mock; update: Mock };
  $queryRaw: Mock;
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/properties/${PROPERTY}/photos/${PHOTO}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof PATCH>[0],
    { params: Promise.resolve({ id: PROPERTY, photoId: PHOTO }) },
  );

let calls: string[];
let tx: {
  $queryRaw: Mock;
  propertyPhoto: { updateMany: Mock; update: Mock };
};

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue({});
  pm.propertyPhoto.findUnique.mockResolvedValue({
    id: PHOTO,
    propertyId: PROPERTY,
    property: { createdBy: "u1", assignedTo: null },
  });
  tx = {
    $queryRaw: vi.fn(async () => {
      calls.push("lock");
      return [{ id: PROPERTY }];
    }),
    propertyPhoto: {
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
  it("親の物件行を押さえてから、他の代表を外し、この写真を代表にする(同じトランザクション)", async () => {
    const res = await patch({ isPrimary: true });

    expect(res.status).toBe(200);
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["lock", "clearOthers", "update"]);
    expect(tx.propertyPhoto.updateMany).toHaveBeenCalledWith({
      where: { propertyId: PROPERTY, id: { not: PHOTO }, isPrimary: true },
      data: { isPrimary: false },
    });
    // tx の外(base client)では書かない。
    expect(pm.propertyPhoto.updateMany).not.toHaveBeenCalled();
    expect(pm.propertyPhoto.update).not.toHaveBeenCalled();
  });

  it("キャプションだけの更新では他の写真に触らない(ロックは取る)", async () => {
    const res = await patch({ caption: "外観" });

    expect(res.status).toBe(200);
    expect(calls).toEqual(["lock", "update"]);
    expect(tx.propertyPhoto.updateMany).not.toHaveBeenCalled();
  });

  it("ロック時点で担当外になっていたら(0行)403で、何も書かない", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "field_staff" });
    tx.$queryRaw.mockResolvedValueOnce([]);

    const res = await patch({ isPrimary: true });

    expect(res.status).toBe(403);
    expect(tx.propertyPhoto.updateMany).not.toHaveBeenCalled();
    expect(tx.propertyPhoto.update).not.toHaveBeenCalled();
  });
});
