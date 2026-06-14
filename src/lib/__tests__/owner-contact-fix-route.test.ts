/**
 * POST /api/admin/owners/:id/correction/contact-fix のルートテスト（DQ-02）。
 *
 * 観点: 認可（owner:write + field-level write）/ 入力検証 / dryRun の eligible・blockReasons /
 * 実行（楽観ロック・ChangeLog・AuditLog 非PII・新version）/ tx version_mismatch /
 * 不可視フィールドの同値オラクル抑止。
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
import { POST } from "../../app/api/admin/owners/[id]/correction/contact-fix/route";

const pm = prisma as unknown as {
  owner: { findUnique: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  $transaction: Mock;
};

const PERMS_RW = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_zip", action: "full", granted: true },
  { resource: "owner_phone", action: "full", granted: true },
];
const PERMS_RO = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
// owner:write はあるが owner_zip の field-level write 無し（read のみ＝可視だが書込不可）。
const PERMS_RW_NO_FIELD = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_zip", action: "read", granted: true },
];
// owner_zip が masked（生値不可視）。dryRun preview のみ。
const PERMS_RO_FIELD_MASKED = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_zip", action: "masked", granted: true },
];

function req(body: unknown) {
  return new Request("http://localhost/api/admin/owners/o-1/correction/contact-fix", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}
const params = { params: Promise.resolve({ id: "o-1" }) };

function mockOwner(
  over: Partial<{ zip: string | null; phone: string | null; version: number; isArchived: boolean }> = {},
) {
  pm.owner.findUnique.mockResolvedValue({
    id: "o-1",
    zip: over.zip ?? "123",
    phone: over.phone ?? null,
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
    expect((await POST(req({ version: 1, field: "zip", mode: "format" }), params)).status).toBe(403);
  });

  it("実行時 owner:write 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RO);
    const res = await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "123-4567", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
  });

  it("owner:write はあるが field-level write 無しは実行 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RW_NO_FIELD);
    const res = await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "123-4567", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("dryRun は owner:write 不要", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RO);
    const res = await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "123-4567" }),
      params,
    );
    expect(res.status).toBe(200);
  });
});

describe("入力検証", () => {
  it("version 不正で 400", async () => {
    expect((await POST(req({ field: "zip", mode: "format" }), params)).status).toBe(400);
  });
  it("field 不正で 400", async () => {
    expect((await POST(req({ version: 1, field: "x", mode: "format" }), params)).status).toBe(400);
  });
  it("mode 不正で 400", async () => {
    expect((await POST(req({ version: 1, field: "zip", mode: "x" }), params)).status).toBe(400);
  });
  it("set で newValue 無しは 400", async () => {
    expect((await POST(req({ version: 1, field: "zip", mode: "set" }), params)).status).toBe(400);
  });
});

describe("not found", () => {
  it("owner 不存在で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(null);
    expect((await POST(req({ version: 1, field: "zip", mode: "format" }), params)).status).toBe(404);
  });
});

describe("dryRun: format", () => {
  it("valid 未整形 zip は eligible", async () => {
    mockOwner({ zip: "1234567" });
    const res = await POST(req({ version: 1, field: "zip", mode: "format" }), params);
    const json = await res.json();
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });
  it("suspicious zip は format 不可（manual/suspicious）", async () => {
    mockOwner({ zip: "123" });
    const res = await POST(req({ version: 1, field: "zip", mode: "format" }), params);
    const json = await res.json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("suspicious");
  });
  it("phone non_phone は manual/non_phone", async () => {
    mockOwner({ phone: "不明" });
    const res = await POST(req({ version: 1, field: "phone", mode: "format" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("non_phone");
  });
});

describe("dryRun: set", () => {
  it("無効な新 zip は forbidden_value", async () => {
    const res = await POST(req({ version: 1, field: "zip", mode: "set", newValue: "999" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("forbidden_value");
  });
  it("version 不一致は version_mismatch", async () => {
    mockOwner({ zip: "123", version: 3 });
    const res = await POST(req({ version: 1, field: "zip", mode: "set", newValue: "123-4567" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("version_mismatch");
  });
  it("phone 不明 → 空クリアは eligible", async () => {
    mockOwner({ phone: "不明" });
    const res = await POST(req({ version: 1, field: "phone", mode: "set", newValue: "" }), params);
    const json = await res.json();
    expect(json.eligible).toBe(true);
  });
});

describe("実行 (dryRun=false)", () => {
  it("set 成功で canonical 保存・ChangeLog・新version", async () => {
    mockOwner({ zip: "123" });
    const res = await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "1234567", dryRun: false }),
      params,
    );
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(json.version).toBe(2);
    expect(json.updatedFields).toEqual(["zip"]);
    const upd = pm.owner.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "o-1", version: 1, isArchived: false });
    expect(upd.data.zip).toBe("123-4567"); // canonical 整形
    const cl = pm.changeLog.createMany.mock.calls[0][0].data[0];
    expect(cl.fieldName).toBe("zip");
    expect(cl.oldValue).toBe("123");
    expect(cl.newValue).toBe("123-4567");
  });

  it("format 成功で整形値に更新", async () => {
    mockOwner({ phone: "０９０（１２３４）５６７８" });
    const res = await POST(req({ version: 1, field: "phone", mode: "format", dryRun: false }), params);
    const json = await res.json();
    expect(json.executed).toBe(true);
    expect(pm.owner.updateMany.mock.calls[0][0].data.phone).toBe("090-1234-5678");
  });

  it("set 空クリアで null 保存", async () => {
    mockOwner({ phone: "不明" });
    const res = await POST(
      req({ version: 1, field: "phone", mode: "set", newValue: "", dryRun: false }),
      params,
    );
    expect((await res.json()).executed).toBe(true);
    expect(pm.owner.updateMany.mock.calls[0][0].data.phone).toBeNull();
  });

  it("AuditLog detail に zip/phone 生値が含まれない", async () => {
    mockOwner({ zip: "1234567" });
    await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "7654321", dryRun: false }),
      params,
    );
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_correction_contact_fix");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("7654321");
    expect(detailJson).not.toContain("1234567");
    expect(call.detail).toHaveProperty("updatedFields");
  });

  it("tx 内 updateMany count=0（version 競合）で 409", async () => {
    mockOwner({ zip: "123" });
    pm.owner.updateMany.mockResolvedValue({ count: 0 });
    pm.owner.findUnique
      .mockResolvedValueOnce({ id: "o-1", zip: "123", phone: null, version: 1, isArchived: false })
      .mockResolvedValueOnce({ version: 2, isArchived: false });
    const res = await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "123-4567", dryRun: false }),
      params,
    );
    expect(res.status).toBe(409);
    expect(pm.changeLog.createMany).not.toHaveBeenCalled();
  });
});

describe("不可視フィールドの dry-run は同値オラクルを出さない", () => {
  it("owner_zip 不可視 + set で current と一致しても no_change/eligible を出さない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ zip: "123-4567", version: 1 });
    const res = await POST(
      req({ version: 1, field: "zip", mode: "set", newValue: "123-4567" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.blockReasons).not.toContain("no_change");
    expect(json).not.toHaveProperty("eligible");
    expect(json.fieldVisible).toBe(false);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  // DQ-02 P2: format mode は現在値を decide*Fix で分類するため、隠し値が
  // suspicious / non_phone / empty / no_change のどれかを blockReasons から
  // 推測できてしまう。不可視フィールドではこれらを一切返さない。
  it("owner_zip 不可視 + format で suspicious な隠し値の blockReasons を漏らさない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ zip: "123", version: 1 }); // suspicious
    const res = await POST(
      req({ version: 1, field: "zip", mode: "format" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.fieldVisible).toBe(false);
    expect(json).not.toHaveProperty("eligible");
    expect(json.blockReasons).not.toContain("suspicious");
    expect(json.blockReasons).not.toContain("no_change");
    expect(json.blockReasons).not.toContain("empty");
    expect(json.blockReasons).not.toContain("manual");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_phone 不可視 + format で non_phone な隠し値の blockReasons を漏らさない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue([
      { resource: "user_management", action: "read", granted: true },
      { resource: "owner", action: "read", granted: true },
      { resource: "owner_phone", action: "hidden", granted: true },
    ]);
    mockOwner({ phone: "不明", version: 1 }); // non_phone
    const res = await POST(
      req({ version: 1, field: "phone", mode: "format" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fieldVisible).toBe(false);
    expect(json.blockReasons).not.toContain("non_phone");
    expect(json.blockReasons).not.toContain("manual");
  });

  it("不可視フィールド + format で formattable な隠し値も eligible を漏らさない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ zip: "1234567", version: 1 }); // valid だが未整形 = format 可能
    const res = await POST(
      req({ version: 1, field: "zip", mode: "format" }),
      params,
    );
    const json = await res.json();
    expect(json).not.toHaveProperty("eligible");
    expect(json.fieldVisible).toBe(false);
    expect(json.blockReasons).toEqual([]);
  });
});
