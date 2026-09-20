import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/owners/[id] は Task 6 で「トランザクション開始 → 所有者行ロック(FOR UPDATE)
// → 編集の鍵の確認 → 条件つき更新」の順に包まれる。既存の版番号・field-level 権限の
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
vi.mock("@/lib/permissions", () => ({ hasPermission: () => true, hasExplicitWritePerm: () => true }));
vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn(), OWNER_TRACKED_FIELDS: [] }));
vi.mock("@/lib/display-level", () => ({ applyDisplayToOwner: vi.fn((x: unknown) => x) }));
vi.mock("@/lib/property-access", () => ({ canAccessPropertyRecord: () => true }));
vi.mock("@/lib/edit-lock/service", () => ({ assertNotEditLockedByOther: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { assertNotEditLockedByOther } from "@/lib/edit-lock/service";
import { PATCH } from "../route";

type PrismaMock = {
  owner: { findUnique: Mock; findUniqueOrThrow: Mock };
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const OWNER = "11111111-1111-4111-8111-111111111111";

const CURRENT_OWNER = {
  id: OWNER,
  version: 1,
  name: "山田太郎",
  nameKana: null,
  phone: null,
  zip: null,
  address: null,
  currentZip: null,
  currentAddress: null,
  note: null,
  email: null,
  corporateNumber: null,
  companyRegistryNumber: null,
};

const UPDATED_OWNER = { ...CURRENT_OWNER, version: 2, propertyOwners: [] as unknown[] };

const patch = (body: unknown, token: string | null = "screen-1") =>
  PATCH(
    new Request(`http://localhost/api/owners/${OWNER}`, {
      method: "PATCH",
      headers: token
        ? { "Content-Type": "application/json", "X-Edit-Screen": token }
        : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof PATCH>[0],
    { params: Promise.resolve({ id: OWNER }) },
  );

function defaultTransactionImpl() {
  return (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: vi.fn(async () => []),
      owner: { updateMany: vi.fn(async () => ({ count: 1 })) },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue([]);
  pm.owner.findUnique.mockResolvedValue(CURRENT_OWNER);
  pm.owner.findUniqueOrThrow.mockResolvedValue(UPDATED_OWNER);
  (pm.$transaction as unknown as Mock).mockImplementation(defaultTransactionImpl());
  (assertNotEditLockedByOther as unknown as Mock).mockResolvedValue(undefined);
});

describe("PATCH /api/owners/[id] と編集中の鍵", () => {
  // ⚠「呼ばれたこと」だけを見るテストでは、トランザクションの外で呼んでも
  //   書き込みの後に呼んでも通ってしまう(@codex R6 P2)。**順序そのもの**を記録して検査する。
  it("トランザクション開始 → 所有者行ロック → 鍵の確認 → 条件つき更新 の順で呼ばれる", async () => {
    const order: string[] = [];
    (pm.$transaction as unknown as Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      order.push("tx");
      return fn({
        $queryRaw: vi.fn(async () => {
          order.push("lock");
          return [];
        }),
        owner: {
          updateMany: vi.fn(async () => {
            order.push("update");
            return { count: 1 };
          }),
        },
      });
    });
    (assertNotEditLockedByOther as unknown as Mock).mockImplementation(async () => {
      order.push("assert");
    });

    await patch({ version: 1, note: "x" });

    expect(order).toEqual(["tx", "lock", "assert", "update"]);
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
      new Request(`http://localhost/api/owners/${OWNER}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Edit-Lock": "not-a-uuid" },
        body: JSON.stringify({ version: 1, note: "x" }),
      }) as unknown as Parameters<typeof PATCH>[0],
      { params: Promise.resolve({ id: OWNER }) },
    );
    expect(res.status).toBe(400);
    expect(assertNotEditLockedByOther).not.toHaveBeenCalled();
  });

  it("X-Edit-Lock が uuid なら世代として渡す", async () => {
    const lockId = "33333333-3333-4333-8333-333333333333";
    await PATCH(
      new Request(`http://localhost/api/owners/${OWNER}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Edit-Screen": "screen-1",
          "X-Edit-Lock": lockId,
        },
        body: JSON.stringify({ version: 1, note: "x" }),
      }) as unknown as Parameters<typeof PATCH>[0],
      { params: Promise.resolve({ id: OWNER }) },
    );
    expect(assertNotEditLockedByOther).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lockId }),
    );
  });

  it("所有者行を FOR UPDATE でロックする(所有者→物件の親行の順序規約)", async () => {
    let sql = "";
    (pm.$transaction as unknown as Mock).mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
          sql = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
          return Promise.resolve([]);
        }),
        owner: { updateMany: vi.fn(async () => ({ count: 1 })) },
      }),
    );
    await patch({ version: 1, note: "x" });
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain(OWNER);
  });
});
