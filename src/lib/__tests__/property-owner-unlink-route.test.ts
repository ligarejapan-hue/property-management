/**
 * DELETE /api/properties/[id]/owners/[ownerId] — 「この物件から外す」の権限。
 *
 * 発注者判断 (2026-08-21):
 *   「削除と付け替えは別のボタンにしてほしい。**事務担当は付け替えだけに**」
 *
 * ⇒ 外す(リンク削除)は**管理者だけ**。事務担当は付け替えのみ。
 *   このリポには role を直接見る仕組みが無く、既存の管理者向け route
 *   (誤紐づき修正) が `user_management:read` を管理者の代理として使っている。
 *   ここでも同じ鍵を使い、判定基準を1つに揃える。
 *
 * ⚠この route は**これまで画面から呼ばれていなかった**(実測: 呼び出し元ゼロ)。
 *   画面に「この物件から外す」を足すと同時に、権限を締める。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {
    constructor(input: string | URL | Request, init?: RequestInit) {
      super(input, init);
    }
  }
  return { NextRequest: MockNextRequest };
});

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    getApiSession: vi.fn(),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      const e = error as { status?: number; message?: string; code?: string };
      if (typeof e?.status === "number") {
        return Response.json(
          { error: { message: e.message, code: e.code } },
          { status: e.status },
        );
      }
      return Response.json(
        { error: { message: "Server error", code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }),
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data, { status }),
    ),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/change-log", () => ({ recordChanges: vi.fn() }));
vi.mock("@/lib/property-record-guard", () => ({ lockPropertyRow: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = { propertyOwner: { delete: vi.fn() } };
  return {
    default: {
      propertyOwner: { findUnique: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { DELETE } from "../../app/api/properties/[id]/owners/[ownerId]/route";

const PROPERTY_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "22222222-2222-4222-8222-222222222222";

/** 管理者相当 (誤紐づき修正 route と同じ鍵を持つ)。 */
const ADMIN_PERMS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

/** 事務担当用テンプレの実データ (本番実測 2026-08-21)。user_management を持たない。 */
const OFFICE_STAFF_PERMS = [
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "property", action: "read", granted: true },
  { resource: "property", action: "write", granted: true },
];

const pm = prisma as unknown as {
  propertyOwner: { findUnique: Mock };
  $transaction: Mock;
  _tx: { propertyOwner: { delete: Mock } };
};

function callDelete() {
  const req = new Request(
    `http://localhost/api/properties/${PROPERTY_ID}/owners/${OWNER_ID}`,
    { method: "DELETE" },
  ) as unknown as import("next/server").NextRequest;
  return DELETE(req, {
    params: Promise.resolve({ id: PROPERTY_ID, ownerId: OWNER_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getApiSession as Mock).mockResolvedValue({ id: "user-1" });
  pm.propertyOwner.findUnique.mockResolvedValue({
    id: LINK_ID,
    propertyId: PROPERTY_ID,
    ownerId: OWNER_ID,
    relationship: null,
    isPrimary: false,
  });
  pm._tx.propertyOwner.delete.mockResolvedValue({});
});

describe("DELETE /api/properties/[id]/owners/[ownerId] の権限", () => {
  it("管理者は外せる", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(pm._tx.propertyOwner.delete).toHaveBeenCalledTimes(1);
  });

  it("事務担当(owner:write はあるが user_management:read が無い)は外せない", async () => {
    (getUserPermissions as Mock).mockResolvedValue(OFFICE_STAFF_PERMS);
    const res = await callDelete();
    expect(res.status).toBe(403);
    // ⚠**外していないこと**まで見る。403 を返しつつ消えていたら意味がない。
    expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
  });

  it("owner:write が無ければ、管理者の鍵を持っていても外せない", async () => {
    (getUserPermissions as Mock).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
  });

  it("権限が無いときは、リンクの存在確認すら行わない(存在の有無を漏らさない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(OFFICE_STAFF_PERMS);
    await callDelete();
    expect(pm.propertyOwner.findUnique).not.toHaveBeenCalled();
  });

  it("外すときは親の物件行を先にロックする(書き込み規約)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    await callDelete();
    expect(lockPropertyRow as Mock).toHaveBeenCalledTimes(1);
    expect((lockPropertyRow as Mock).mock.calls[0][1]).toBe(PROPERTY_ID);
  });
});
