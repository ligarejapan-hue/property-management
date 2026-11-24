/**
 * POST /api/admin/owners/[id]/correction/unarchive route tests(2026-11-24 発注者「作る」)。
 *
 * - アーカイブした所有者(isArchived=true)を一覧に戻す。権限はアーカイブの実行と同じ
 *   (user_management:read + owner:read + owner:delete)
 * - 版(version)が違えば 409・アーカイブされていなければ 404
 * - 行ロックの下で読み直し、where に isArchived=true と版を入れて更新する
 * - ChangeLog(isArchived true→false)と AuditLog を書く。どちらにも PII を入れない
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
    getApiSession: vi.fn().mockResolvedValue({ id: "user-1", role: "admin" }),
    getUserPermissions: vi.fn(),
    handleApiError: vi.fn((error: unknown) => {
      if (error instanceof MockApiError) {
        return Response.json(
          { error: { message: error.message, code: error.code } },
          { status: error.status },
        );
      }
      return Response.json({ error: { message: "Server error" } }, { status: 500 });
    }),
    apiResponse: vi.fn((data: unknown, status = 200) => Response.json(data, { status })),
  };
});

vi.mock("@/lib/audit", () => ({ writeAuditLog: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const tx = {
    owner: { findUnique: vi.fn(), updateMany: vi.fn() },
    changeLog: { create: vi.fn() },
  };
  return {
    default: {
      $transaction: vi.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
      _tx: tx,
    },
  };
});

vi.mock("@/lib/edit-lock/row-locks", () => ({ lockOwnerRow: vi.fn() }));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { lockOwnerRow } from "@/lib/edit-lock/row-locks";
import { POST } from "../../app/api/admin/owners/[id]/correction/unarchive/route";

const OWNER_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const pm = prisma as unknown as {
  $transaction: Mock;
  _tx: {
    owner: { findUnique: Mock; updateMany: Mock };
    changeLog: { create: Mock };
  };
};

const PERMS_FULL = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "delete", granted: true },
];

function req(body: unknown) {
  return new Request(`http://localhost/api/admin/owners/${OWNER_ID}/correction/unarchive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}
const params = () => ({ params: Promise.resolve({ id: OWNER_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL);
  pm._tx.owner.findUnique.mockResolvedValue({ version: 3, isArchived: true });
  pm._tx.owner.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST unarchive", () => {
  it("アーカイブ済みの所有者を戻し、版を1つ上げ、履歴と監査を書く", async () => {
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ executed: true, id: OWNER_ID, version: 4 });

    expect(lockOwnerRow).toHaveBeenCalledWith(pm._tx, OWNER_ID);
    expect(pm._tx.owner.updateMany).toHaveBeenCalledWith({
      where: { id: OWNER_ID, version: 3, isArchived: true },
      data: { isArchived: false, version: { increment: 1 } },
    });
    expect(pm._tx.changeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetTable: "owners",
        targetId: OWNER_ID,
        fieldName: "isArchived",
        oldValue: "true",
        newValue: "false",
        changedBy: "user-1",
      }),
    });
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "owner_correction_unarchive",
        targetTable: "owners",
        targetId: OWNER_ID,
      }),
    );
  });

  it("行ロックを読み直しより前に取る", async () => {
    const order: string[] = [];
    (lockOwnerRow as Mock).mockImplementation(async () => {
      order.push("lock");
    });
    pm._tx.owner.findUnique.mockImplementation(async () => {
      order.push("read");
      return { version: 3, isArchived: true };
    });
    await POST(req({ version: 3 }), params());
    expect(order).toEqual(["lock", "read"]);
  });

  it("owner:delete が無ければ 403(DB に触らない)", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL.slice(0, 2));
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(403);
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("user_management:read が無ければ 403", async () => {
    (getUserPermissions as Mock).mockResolvedValue(PERMS_FULL.slice(1));
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(403);
  });

  it("version が正の整数でなければ 400", async () => {
    for (const v of [undefined, 0, -1, 1.5, "3"]) {
      const res = await POST(req({ version: v }), params());
      expect(res.status).toBe(400);
    }
    expect(pm.$transaction).not.toHaveBeenCalled();
  });

  it("所有者が無いときは 404・書き込まない", async () => {
    pm._tx.owner.findUnique.mockResolvedValue(null);
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(404);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("アーカイブされていない所有者は 404(二重に戻さない)", async () => {
    pm._tx.owner.findUnique.mockResolvedValue({ version: 3, isArchived: false });
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(404);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
  });

  it("版が違えば 409・書き込まない", async () => {
    pm._tx.owner.findUnique.mockResolvedValue({ version: 4, isArchived: true });
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(409);
    expect(pm._tx.owner.updateMany).not.toHaveBeenCalled();
    expect(pm._tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("更新が0件なら 409・履歴も監査も書かない", async () => {
    pm._tx.owner.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req({ version: 3 }), params());
    expect(res.status).toBe(409);
    expect(pm._tx.changeLog.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
