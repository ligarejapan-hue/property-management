import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// review round2 item 6: DELETE /api/properties/[id] の後始末(deleteEditLocksFor)は
// これまで走査(`await deleteEditLocksFor(` が存在するか)だけで守られていた。
// これは「呼ばれること」しか示さず、「行ロックの後・削除の前に呼ばれること」までは
// 示さない。archive/rollback と同じ技法(モックした $transaction で順序と tx の
// 同一性をピン留めする)をここにも適用する。

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
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn(() => ({ delete: vi.fn() })) }));
vi.mock("@/lib/storage/url-to-key", () => ({ extractStorageKeyFromUrl: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));
vi.mock("@/lib/edit-lock/service", () => ({
  assertNotEditLockedByOther: vi.fn(),
  deleteEditLocksFor: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    // ⚠base client にも property.delete を置く(実装が誤って tx の代わりに base
    //   client を使ってしまう回帰を「呼ばれていない」の形で拾えるようにするため)。
    property: { findUnique: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { deleteEditLocksFor } from "@/lib/edit-lock/service";
import { DELETE } from "../route";

type PrismaMock = {
  property: { findUnique: Mock; delete: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const PROP = "22222222-2222-4222-8222-222222222222";

const CURRENT_PROPERTY = {
  id: PROP,
  address: "東京都千代田区1-1-1",
  createdBy: "u1",
  assignedTo: null,
};

const deleteRequest = () =>
  DELETE(
    new Request(`http://localhost/api/properties/${PROP}`, { method: "DELETE" }) as unknown as Parameters<
      typeof DELETE
    >[0],
    { params: Promise.resolve({ id: PROP }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as unknown as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as unknown as Mock).mockResolvedValue([]);
  pm.property.findUnique.mockResolvedValue(CURRENT_PROPERTY);
  (lockPropertyRow as unknown as Mock).mockResolvedValue(undefined);
  (deleteEditLocksFor as unknown as Mock).mockResolvedValue(0);
});

describe("DELETE /api/properties/[id] と鍵の後始末の順序", () => {
  it("Task 8: lockPropertyRow(行ロック) → 査定申込チェック → deleteEditLocksFor(後始末) → property.delete の順で、同じ tx を使う", async () => {
    const order: string[] = [];
    let txClient: unknown;
    let lockTxArg: unknown;
    let cleanupTxArg: unknown;

    pm.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      txClient = {
        // main合流で追加された査定申込(dm_inquiries)ガード: 親行ロックの直後に
        // 件数を数え、1件でもあれば 409 で止める(HAS_DM_INQUIRIES)。ここでは
        // 0 を返して通常の削除継続経路をテストする。
        dmInquiry: {
          count: vi.fn(async () => {
            order.push("inquiryCheck");
            return 0;
          }),
        },
        propertyPhoto: { findMany: vi.fn(async () => []) },
        attachment: { updateMany: vi.fn(async () => ({ count: 0 })) },
        propertyDmLog: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        property: {
          delete: vi.fn(async () => {
            order.push("delete");
            return {};
          }),
        },
      };
      return fn(txClient);
    });
    (lockPropertyRow as unknown as Mock).mockImplementation(async (tx: unknown) => {
      order.push("lock");
      lockTxArg = tx;
    });
    (deleteEditLocksFor as unknown as Mock).mockImplementation(async (tx: unknown) => {
      order.push("cleanup");
      cleanupTxArg = tx;
      return 0;
    });

    const res = await deleteRequest();

    expect(res.status).toBe(200);
    // main合流で「lock」の直後に査定申込チェック(dmInquiry.count)が入った。
    // 親行ロック→申込チェック→(写真/添付/DMログの後始末)→鍵の後始末→削除、
    // という実際の順序のうち意味のある境目だけを記録している。
    expect(order).toEqual(["tx", "lock", "inquiryCheck", "cleanup", "delete"]);
    // ⚠tx そのもの(identity)に対して呼ばれたこと(base client=prisma のトップレベル
    //   ではないこと)を固定する。
    expect(lockTxArg).toBe(txClient);
    expect(cleanupTxArg).toBe(txClient);
    expect(lockPropertyRow).toHaveBeenCalledWith(txClient, PROP);
    expect(deleteEditLocksFor).toHaveBeenCalledWith(txClient, [
      { resourceType: "property", resourceId: PROP },
    ]);
    // 書き込みが base client(prisma.property.delete)に漏れていない
    // (=トランザクションの外へ逃げていない)ことを固定する。
    expect(pm.property.delete).not.toHaveBeenCalled();
  });
});
