import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/properties/[id] は Task 6 で「トランザクション開始 → 物件行ロック →
// 編集の鍵の確認 → 条件つき更新」の順に包まれる。既存の版番号・registryStatus の
// 条件・監査ログの位置は変えない。ここでは鍵まわりの挙動だけを検査する。

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
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn((x: unknown) => x) }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    // ⚠`property.updateMany` を base client 側にも置く(実装が誤って tx の代わりに
    //   base client を使ってしまう回帰を「呼ばれていない」の形で拾えるようにするため。
    //   本来の書き込みは必ず $transaction が渡す別オブジェクト(tx)側で行われる)。
    property: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    changeLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { PATCH } from "../route";

type PrismaMock = {
  property: { findUnique: Mock; findUniqueOrThrow: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const PROP = "22222222-2222-4222-8222-222222222222";

const CURRENT_PROPERTY = {
  id: PROP,
  version: 1,
  createdBy: "u1",
  assignedTo: null,
  propertyType: "land",
  address: "東京都千代田区1-1-1",
  postalCode: "100-0001",
  lotNumber: null,
  buildingNumber: null,
  buildingName: null,
  realEstateNumber: null,
  registryStatus: null,
  dmStatus: null,
  caseStatus: "new_case",
  introductionRoute: null,
  gpsLat: null,
  gpsLng: null,
  zoningDistrict: null,
  buildingCoverageRatio: null,
  floorAreaRatio: null,
  heightDistrict: null,
  firePreventionZone: null,
  scenicRestriction: null,
  roadType: null,
  roadWidth: null,
  frontageWidth: null,
  frontageDirection: null,
  setbackRequired: null,
  rosenkaValue: null,
  rosenkaYear: null,
  rebuildPermission: null,
  architectureNote: null,
  note: null,
};

const UPDATED_PROPERTY = {
  ...CURRENT_PROPERTY,
  version: 2,
  assignee: null,
  creator: null,
  propertyOwners: [],
  photos: [],
  nextActions: [],
};

const patch = (body: unknown, token: string | null = "screen-1") =>
  PATCH(
    new Request(`http://localhost/api/properties/${PROP}`, {
      method: "PATCH",
      headers: token
        ? { "Content-Type": "application/json", "X-Edit-Screen": token }
        : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof PATCH>[0],
    { params: Promise.resolve({ id: PROP }) },
  );

function defaultTransactionImpl() {
  return (fn: (tx: unknown) => unknown) =>
    fn({
      property: { updateMany: vi.fn(async () => ({ count: 1 })) },
      $queryRaw: vi.fn(async () => []),
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.property.findUnique.mockResolvedValue(CURRENT_PROPERTY);
  pm.property.findUniqueOrThrow.mockResolvedValue(UPDATED_PROPERTY);
  pm.changeLog.createMany.mockResolvedValue({ count: 0 });
  (pm.$transaction as unknown as Mock).mockImplementation(defaultTransactionImpl());
  (lockPropertyRow as unknown as Mock).mockResolvedValue(undefined);
  (assertNotEditLockedByOther as unknown as Mock).mockResolvedValue(undefined);
});

describe("PATCH /api/properties/[id] と編集中の鍵", () => {
  // ⚠「呼ばれたこと」だけを見るテストでは、トランザクションの外で呼んでも
  //   書き込みの後に呼んでも通ってしまう(@codex R6 P2)。**順序そのもの**を記録して検査する。
  // ⚠さらに、順序が正しくても lock/assert が base client(prisma)に対して
  //   呼ばれていたら TOCTOU の窓は閉じない。**tx そのものが渡ったこと**(identity)と
  //   **base client の updateMany が呼ばれていないこと**まで固定する(review Important 1/2)。
  it("トランザクション開始 → 行ロック → 鍵の確認 → 条件つき更新 の順で呼ばれ、すべて同じ tx を使う", async () => {
    const order: string[] = [];
    let txClient: unknown;
    (pm.$transaction as unknown as Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      // ⚠base client(pm)とは別物のオブジェクトにする。tx と base を混同する
      //   回帰(例: assertNotEditLockedByOther(prisma, …))を検出できるようにする。
      txClient = {
        property: {
          updateMany: vi.fn(async () => {
            order.push("update");
            return { count: 1 };
          }),
        },
        $queryRaw: vi.fn(async () => []),
      };
      return fn(txClient);
    });
    (lockPropertyRow as unknown as Mock).mockImplementation(async () => {
      order.push("lock");
    });
    (assertNotEditLockedByOther as unknown as Mock).mockImplementation(async () => {
      order.push("assert");
    });

    const res = await patch({ version: 1, note: "x" });

    expect(res.status).toBe(200);
    expect(order).toEqual(["tx", "lock", "assert", "update"]);
    expect(lockPropertyRow).toHaveBeenCalledTimes(1);
    expect((lockPropertyRow as unknown as Mock).mock.calls[0][0]).toBe(txClient);
    expect((lockPropertyRow as unknown as Mock).mock.calls[0][1]).toBe(PROP);
    expect(assertNotEditLockedByOther).toHaveBeenCalledTimes(1);
    expect((assertNotEditLockedByOther as unknown as Mock).mock.calls[0][0]).toBe(txClient);
    // 書き込みが base client(prisma.property.updateMany)に漏れていない
    // (=トランザクションの外へ逃げていない)ことを固定する。
    expect(pm.property.updateMany).not.toHaveBeenCalled();
  });

  it("鍵が他人のものなら 423 を返し、版番号の更新は走らない", async () => {
    (assertNotEditLockedByOther as unknown as Mock).mockRejectedValueOnce(
      Object.assign(new Error("他の画面で編集中です"), { status: 423, code: "EDIT_LOCKED" }),
    );
    const res = await patch({ version: 1, note: "x" });
    expect(res.status).toBe(423);
  });

  it("合言葉のヘッダが無くても呼ばれる(古い画面。鍵が無ければ通る)", async () => {
    const res = await patch({ version: 1, note: "x" }, null);
    expect(res.status).toBe(200);
    expect(assertNotEditLockedByOther).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ screenTokenHash: null }),
    );
  });

  it("X-Edit-Lock が uuid でなければ 400 を返し、鍵の確認自体が走らない", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/properties/${PROP}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Edit-Lock": "not-a-uuid" },
        body: JSON.stringify({ version: 1, note: "x" }),
      }) as unknown as Parameters<typeof PATCH>[0],
      { params: Promise.resolve({ id: PROP }) },
    );
    expect(res.status).toBe(400);
    expect(assertNotEditLockedByOther).not.toHaveBeenCalled();
  });

  it("X-Edit-Lock が uuid なら世代として渡す", async () => {
    const lockId = "33333333-3333-4333-8333-333333333333";
    await PATCH(
      new Request(`http://localhost/api/properties/${PROP}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Edit-Screen": "screen-1",
          "X-Edit-Lock": lockId,
        },
        body: JSON.stringify({ version: 1, note: "x" }),
      }) as unknown as Parameters<typeof PATCH>[0],
      { params: Promise.resolve({ id: PROP }) },
    );
    expect(assertNotEditLockedByOther).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lockId }),
    );
  });
});
