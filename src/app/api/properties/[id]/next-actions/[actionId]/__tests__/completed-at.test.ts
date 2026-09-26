import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// PATCH /api/properties/[id]/next-actions/[actionId] の「完了にする」。
// 画面は目的の値(isCompleted: true/false)を送るので、2人がほぼ同時に「完了」を
// 押しても結果は壊れない。ただし以前は2人目の更新が完了時刻(completedAt)を
// 自分の時刻で上書きしていた。すでに完了している予定を再び「完了」にしても、
// 最初の完了時刻は残す(親の物件行を押さえた後の同じ tx で今の値を読んで決める)。

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
vi.mock("@/lib/property-record-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-record-guard")>()),
  assertPropertyRecordAccess: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    nextAction: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import prisma from "@/lib/prisma";
import { PATCH } from "../route";

type PrismaMock = {
  nextAction: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock };
  $queryRaw: Mock;
  $transaction: Mock;
};
const pm = prisma as unknown as PrismaMock;

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ACTION = "55555555-5555-4555-8555-555555555555";
const FIRST_COMPLETED_AT = new Date("2026-09-26T01:00:00.000Z");

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/properties/${PROPERTY}/next-actions/${ACTION}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof PATCH>[0],
    { params: Promise.resolve({ id: PROPERTY, actionId: ACTION }) },
  );

let calls: string[];
let tx: {
  $queryRaw: Mock;
  nextAction: { findUnique: Mock; updateMany: Mock; findUniqueOrThrow: Mock };
};

function setCurrent(isCompleted: boolean) {
  const row = {
    id: ACTION,
    propertyId: PROPERTY,
    isCompleted,
    completedAt: isCompleted ? FIRST_COMPLETED_AT : null,
  };
  pm.nextAction.findUnique.mockResolvedValue(row);
  tx.nextAction.findUnique.mockImplementation(async () => {
    calls.push("read");
    return row;
  });
}

function updateData(): Record<string, unknown> {
  return tx.nextAction.updateMany.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  (getApiSession as Mock).mockResolvedValue({ id: "u1", role: "admin" });
  (getUserPermissions as Mock).mockResolvedValue({});
  tx = {
    $queryRaw: vi.fn(async () => {
      calls.push("lock");
      return [{ id: PROPERTY }];
    }),
    nextAction: {
      findUnique: vi.fn(),
      updateMany: vi.fn(async () => {
        calls.push("update");
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ id: ACTION })),
    },
  };
  pm.$transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
});

describe("PATCH 完了にする(最初の完了時刻を上書きしない)", () => {
  it("未完了 → 完了: 完了時刻を今にする", async () => {
    setCurrent(false);
    const res = await patch({ isCompleted: true });

    expect(res.status).toBe(200);
    expect(updateData().isCompleted).toBe(true);
    expect(updateData().completedAt).toBeInstanceOf(Date);
  });

  it("すでに完了 → 完了(2人目): 完了時刻に触らない", async () => {
    setCurrent(true);
    const res = await patch({ isCompleted: true });

    expect(res.status).toBe(200);
    expect(updateData().isCompleted).toBe(true);
    expect("completedAt" in updateData()).toBe(false);
  });

  it("完了 → 未完了: 完了時刻を消す", async () => {
    setCurrent(true);
    const res = await patch({ isCompleted: false });

    expect(res.status).toBe(200);
    expect(updateData().isCompleted).toBe(false);
    expect(updateData().completedAt).toBeNull();
  });

  it("今の値は、親の物件行を押さえた後に同じトランザクションで読む", async () => {
    setCurrent(true);
    await patch({ isCompleted: true });

    expect(calls).toEqual(["lock", "read", "update"]);
  });
});
