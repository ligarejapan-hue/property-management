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
  const tx = {
    propertyOwner: { delete: vi.fn(), findUnique: vi.fn() },
    changeLog: { createMany: vi.fn() },
  };
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
  _tx: {
    propertyOwner: { delete: Mock; findUnique: Mock };
    changeLog: { createMany: Mock };
  };
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
  pm._tx.propertyOwner.findUnique.mockResolvedValue({
    id: LINK_ID,
    propertyId: PROPERTY_ID,
    ownerId: OWNER_ID,
    relationship: null,
    isPrimary: false,
  });
  pm._tx.propertyOwner.delete.mockResolvedValue({});
  pm._tx.changeLog.createMany.mockResolvedValue({ count: 1 });
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

// ── @codex #400 R1 P1 ────────────────────────────────────────────────
describe("DELETE: 物件の編集権限も要る (@codex #400 R1 P1)", () => {
  it("property:write が無ければ外せない", () => {
    // 付け替え(mislink)は property:write を要求している。**壊す側だけ緩い**のは筋が通らない。
    return (async () => {
      (getUserPermissions as Mock).mockResolvedValue([
        { resource: "user_management", action: "read", granted: true },
        { resource: "owner", action: "read", granted: true },
        { resource: "owner", action: "write", granted: true },
        { resource: "property", action: "read", granted: true },
        // property:write なし
      ]);
      const res = await callDelete();
      expect(res.status).toBe(403);
      expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
    })();
  });
});

describe("DELETE: ロック後に読み直す (@codex #400 R1 P1)", () => {
  it("先に読んだ行の所有者が、ロック後に別人へ差し替わっていたら消さない", async () => {
    // ⚠付け替え(relink)は**同じ行の ownerId を書き換える**。最初に読んだ行 id を
    //   そのまま消すと、**確認画面で名前を見せた人とは別の人**の紐付けを消す。
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    // トランザクション内で読み直すと、もうこの所有者では見つからない
    pm._tx.propertyOwner.findUnique.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(409);
    expect(pm._tx.propertyOwner.delete).not.toHaveBeenCalled();
  });

  it("読み直しは**ロックを取ってから**行う(取る前に読んでも意味がない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    const order: string[] = [];
    (lockPropertyRow as Mock).mockImplementation(async () => {
      order.push("lock");
    });
    pm._tx.propertyOwner.findUnique.mockImplementation(async () => {
      order.push("reread");
      return {
        id: LINK_ID,
        propertyId: PROPERTY_ID,
        ownerId: OWNER_ID,
        relationship: null,
        isPrimary: false,
      };
    });
    pm._tx.propertyOwner.delete.mockImplementation(async () => {
      order.push("delete");
      return {};
    });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(order).toEqual(["lock", "reread", "delete"]);
  });

  it("消すのは**読み直した行**(古い id を握り続けない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    const FRESH_LINK_ID = "55555555-5555-4555-8555-555555555555";
    pm._tx.propertyOwner.findUnique.mockResolvedValue({
      id: FRESH_LINK_ID,
      propertyId: PROPERTY_ID,
      ownerId: OWNER_ID,
      relationship: "共有",
      isPrimary: true,
    });
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(pm._tx.propertyOwner.delete).toHaveBeenCalledWith({
      where: { id: FRESH_LINK_ID },
    });
  });
});

// ── @codex #400 R2 P2 ────────────────────────────────────────────────
describe("DELETE: 変更履歴に削除の印を残す (@codex #400 R2 P2)", () => {
  it("外したら ChangeLog 行が作られる", async () => {
    // ⚠従来の recordChanges({ newValues: {} }) は**1行も作らない**
    //   (change-log.ts は newValues に無い項目を飛ばす)。
    //   壊す操作が履歴に残らないのは困る。
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(pm._tx.changeLog.createMany).toHaveBeenCalledTimes(1);
    const arg = pm._tx.changeLog.createMany.mock.calls[0][0];
    expect(Array.isArray(arg.data)).toBe(true);
    expect(arg.data.length).toBeGreaterThan(0);
  });

  it("履歴は削除トランザクションの中で書く(消えたのに履歴が無い、を作らない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    const order: string[] = [];
    pm._tx.propertyOwner.delete.mockImplementation(async () => {
      order.push("delete");
      return {};
    });
    pm._tx.changeLog.createMany.mockImplementation(async () => {
      order.push("changelog");
      return { count: 1 };
    });
    await callDelete();
    // どちらも tx の中で呼ばれている(= $transaction のコールバック内)
    expect(order).toContain("delete");
    expect(order).toContain("changelog");
    expect(pm.$transaction).toHaveBeenCalledTimes(1);
  });

  it("履歴に氏名・メモなどの個人情報を入れない", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    pm._tx.propertyOwner.findUnique.mockResolvedValue({
      id: LINK_ID,
      propertyId: PROPERTY_ID,
      ownerId: OWNER_ID,
      relationship: "共有",
      isPrimary: true,
      note: "ここは絶対に履歴へ出してはいけないメモ",
    });
    await callDelete();
    const serialized = JSON.stringify(
      pm._tx.changeLog.createMany.mock.calls[0][0],
    );
    expect(serialized).not.toContain("ここは絶対に履歴へ出してはいけないメモ");
  });

  it("消えなかったとき(409)は履歴も書かない", async () => {
    (getUserPermissions as Mock).mockResolvedValue(ADMIN_PERMS);
    pm._tx.propertyOwner.findUnique.mockResolvedValue(null);
    const res = await callDelete();
    expect(res.status).toBe(409);
    expect(pm._tx.changeLog.createMany).not.toHaveBeenCalled();
  });
});
