/**
 * POST /api/admin/owners/:id/correction/name-fix のルートテスト（DQ-01）。
 *
 * 検証観点:
 * - 認可（user_management:read / owner:read の 403、実行時 owner:write の 403）
 * - 入力検証（version / mode / newName の 400）
 * - dryRun の eligible / blockReasons（sanitize 可否・set の forbidden_value / version_mismatch）
 * - 実行: 楽観ロック更新・ChangeLog 記録・AuditLog PII フリー・新 version
 * - tx 内 version_mismatch（updateMany count=0）で 409
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("next/server", () => {
  class MockNextRequest extends Request {}
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

vi.mock("@/lib/prisma", () => ({
  default: {
    owner: { findUnique: vi.fn(), updateMany: vi.fn() },
    changeLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import prisma from "@/lib/prisma";
import { getUserPermissions } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { POST } from "../../app/api/admin/owners/[id]/correction/name-fix/route";

const pm = prisma as unknown as {
  owner: { findUnique: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  $transaction: Mock;
};

const PERMS_RW = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
];
const PERMS_RO = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];

const SOH = String.fromCharCode(1);

function req(body: unknown) {
  return new Request("http://localhost/api/admin/owners/o-1/correction/name-fix", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}
const params = { params: Promise.resolve({ id: "o-1" }) };

function mockOwner(over: Partial<{ name: string; version: number; isArchived: boolean }> = {}) {
  pm.owner.findUnique.mockResolvedValue({
    id: "o-1",
    name: over.name ?? "44225",
    version: over.version ?? 1,
    isArchived: over.isArchived ?? false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RW);
  mockOwner();
  pm.owner.updateMany.mockResolvedValue({ count: 1 });
  pm.changeLog.createMany.mockResolvedValue({ count: 1 });
  // $transaction はコールバックに tx を渡して実行する。
  pm.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      owner: { updateMany: pm.owner.updateMany, findUnique: pm.owner.findUnique },
      changeLog: { createMany: pm.changeLog.createMany },
    }),
  );
});

describe("認可", () => {
  it("user_management:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "owner", action: "read", granted: true },
    ]);
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    expect(res.status).toBe(403);
  });

  it("実行時 owner:write 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RO);
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
  });

  it("dryRun は owner:write 不要", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RO);
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎" }),
      params,
    );
    expect(res.status).toBe(200);
  });
});

describe("入力検証", () => {
  it("version 不正で 400", async () => {
    expect((await POST(req({ mode: "sanitize" }), params)).status).toBe(400);
  });
  it("mode 不正で 400", async () => {
    expect((await POST(req({ version: 1, mode: "x" }), params)).status).toBe(400);
  });
  it("set で newName 無しは 400", async () => {
    expect((await POST(req({ version: 1, mode: "set" }), params)).status).toBe(400);
  });
});

describe("not found", () => {
  it("owner 不存在で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(null);
    expect((await POST(req({ version: 1, mode: "sanitize" }), params)).status).toBe(404);
  });
});

describe("dryRun: eligible / blockReasons", () => {
  it("制御文字混入は sanitize で eligible", async () => {
    mockOwner({ name: "Yamada" + SOH + "Taro" });
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("数値ゴミは sanitize 不可 → no_safe_autofix", async () => {
    mockOwner({ name: "44225" });
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("no_safe_autofix");
  });

  it("set で再びゴミ（数値のみ）は forbidden_value", async () => {
    const res = await POST(req({ version: 1, mode: "set", newName: "999" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("forbidden_value");
  });

  it("set で version 不一致は version_mismatch", async () => {
    mockOwner({ name: "44225", version: 3 });
    const res = await POST(req({ version: 1, mode: "set", newName: "山田太郎" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("version_mismatch");
  });
});

describe("実行 (dryRun=false)", () => {
  it("set 成功で更新・ChangeLog 記録・新 version", async () => {
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎", dryRun: false }),
      params,
    );
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(json.version).toBe(2);
    expect(json.updatedFields).toEqual(["name"]);

    expect(pm.owner.updateMany).toHaveBeenCalledOnce();
    const upd = pm.owner.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "o-1", version: 1, isArchived: false });
    expect(upd.data.name).toBe("山田太郎");

    expect(pm.changeLog.createMany).toHaveBeenCalledOnce();
    const cl = pm.changeLog.createMany.mock.calls[0][0].data[0];
    expect(cl.fieldName).toBe("name");
    expect(cl.oldValue).toBe("44225");
    expect(cl.newValue).toBe("山田太郎");
  });

  it("sanitize 成功で制御文字を除いた値に更新", async () => {
    mockOwner({ name: "Yamada" + SOH + "Taro" });
    const res = await POST(req({ version: 1, mode: "sanitize", dryRun: false }), params);
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(pm.owner.updateMany.mock.calls[0][0].data.name).toBe("YamadaTaro");
  });

  it("AuditLog detail に氏名生値が含まれない", async () => {
    await POST(
      req({ version: 1, mode: "set", newName: "山田太郎", dryRun: false }),
      params,
    );
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_correction_name_fix");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("山田太郎");
    expect(detailJson).not.toContain("44225");
    expect(call.detail).toHaveProperty("updatedFields");
  });

  it("tx 内 updateMany count=0（version 競合）で 409", async () => {
    pm.owner.updateMany.mockResolvedValue({ count: 0 });
    // recheck: owner は存在し version が進んでいる
    pm.owner.findUnique
      .mockResolvedValueOnce({ id: "o-1", name: "44225", version: 1, isArchived: false }) // 初回ロード
      .mockResolvedValueOnce({ version: 2, isArchived: false }); // tx 内 recheck
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎", dryRun: false }),
      params,
    );
    expect(res.status).toBe(409);
    expect(pm.changeLog.createMany).not.toHaveBeenCalled();
  });
});
