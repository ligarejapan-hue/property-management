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
    propertyPhoto: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { PATCH, DELETE } from "../route";
import { getStorage } from "@/lib/storage";

type PrismaMock = {
  propertyPhoto: { findUnique: Mock; updateMany: Mock; update: Mock; deleteMany: Mock; delete: Mock };
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
let updateCount: number;
let tx: {
  $queryRaw: Mock;
  propertyPhoto: { updateMany: Mock; findUnique: Mock };
};

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  updateCount = 1;
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
      // 「他の代表を外す」(where.id が {not}) と「この写真の更新」(where.id が文字列) を分ける。
      updateMany: vi.fn(async (args: { where: { id: unknown } }) => {
        if (typeof args.where.id === "string") {
          calls.push("update");
          return { count: updateCount };
        }
        calls.push("clearOthers");
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => {
        calls.push("read");
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
    expect(calls).toEqual(["lock", "clearOthers", "update", "read"]);
    expect(tx.propertyPhoto.updateMany).toHaveBeenCalledWith({
      where: { propertyId: PROPERTY, id: { not: PHOTO }, isPrimary: true },
      data: { isPrimary: false },
    });
    // tx の外(base client)では書かない。
    expect(pm.propertyPhoto.updateMany).not.toHaveBeenCalled();
    expect(pm.propertyPhoto.update).not.toHaveBeenCalled();
  });

  // 「代表にする」の途中で写真が削除されていた(ほかの操作と競合)。以前は最後の更新が
  // 「対象が無い」で失敗して 500 になっていた。404 で知らせ、他の代表を外した分も巻き戻す
  // (トランザクションの中で投げる=まとめて取り消される)。
  it("途中で写真が削除されていたら 404(500 にしない)", async () => {
    updateCount = 0;
    const res = await patch({ isPrimary: true });
    expect(res.status).toBe(404);
    expect(calls).toEqual(["lock", "clearOthers", "update"]);
  });

  it("キャプションだけの更新では他の写真に触らない(ロックは取る)", async () => {
    const res = await patch({ caption: "外観" });

    expect(res.status).toBe(200);
    expect(calls).toEqual(["lock", "update", "read"]);
  });

  it("ロック時点で担当外になっていたら(0行)403で、何も書かない", async () => {
    (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "field_staff" });
    tx.$queryRaw.mockResolvedValueOnce([]);

    const res = await patch({ isPrimary: true });

    expect(res.status).toBe(403);
    expect(tx.propertyPhoto.updateMany).not.toHaveBeenCalled();
    expect(tx.propertyPhoto.findUnique).not.toHaveBeenCalled();
  });
});

// 2人がほぼ同時に同じ写真を削除すると、後の人の delete が「対象が無い」で 500 になっていた。
// 0件なら 404(ほかの操作で削除済み)で知らせ、実体ファイルの削除にも進まない。
describe("DELETE 同じ写真をほぼ同時に削除", () => {
  const del = () =>
    DELETE(
      new Request("http://localhost/x", { method: "DELETE" }) as unknown as Parameters<typeof DELETE>[0],
      { params: Promise.resolve({ id: PROPERTY, photoId: PHOTO }) },
    );

  it("すでに消えていたら 404 で、実体ファイルの削除に進まない", async () => {
    pm.propertyPhoto.findUnique.mockResolvedValue({ id: PHOTO, propertyId: PROPERTY, fileUrl: "/uploads/a.jpg", fileName: "a.jpg", property: { createdBy: "u1", assignedTo: null } });
    pm.propertyPhoto.deleteMany.mockResolvedValue({ count: 0 });
    const res = await del();
    expect(res.status).toBe(404);
    expect(getStorage).not.toHaveBeenCalled();
  });
});

