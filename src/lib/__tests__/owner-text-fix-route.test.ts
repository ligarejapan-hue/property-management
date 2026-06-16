/**
 * POST /api/admin/owners/:id/correction/text-fix のルートテスト（DQ-04）。
 *
 * 検証観点:
 * - 認可（user_management:read / owner:read の 403、実行時 owner:write + field-level write の 403）
 * - 入力検証（version / field[name|nameKana|address] / mode / newValue の 400・note は 400）
 * - dryRun の eligible / blockReasons（sanitize 可否・set の forbidden_value / version_mismatch）
 * - フィールド不可視時の hidden oracle 抑止（sanitize=全件 / set=no_change のみ）
 * - 実行: 楽観ロック更新・ChangeLog 記録・AuditLog 非PII・新 version
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
import { POST } from "../../app/api/admin/owners/[id]/correction/text-fix/route";

const pm = prisma as unknown as {
  owner: { findUnique: Mock; updateMany: Mock };
  changeLog: { createMany: Mock };
  $transaction: Mock;
};

const SOH = String.fromCharCode(1);
const FFFD = String.fromCharCode(0xfffd);

// owner_name の full（read+write）を持つ標準 RW。
const PERMS_RW = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "full", granted: true },
];
const PERMS_RO = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
// owner:write はあるが owner_name の field-level write（full/edit）が無い（masked）。
const PERMS_RW_NO_FIELD = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "masked", granted: true },
];
// owner_name 不可視（masked）+ 読取のみ（dryRun preview のみ可）。
const PERMS_RO_FIELD_MASKED = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "masked", granted: true },
];
// owner_name 可視（read）。
const PERMS_RO_FIELD_VISIBLE = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "read", granted: true },
];
// address fix 用（owner_address full）。
const PERMS_RW_ADDRESS = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_address", action: "full", granted: true },
];

function req(body: unknown) {
  return new Request(
    "http://localhost/api/admin/owners/o-1/correction/text-fix",
    { method: "POST", body: JSON.stringify(body) },
  ) as unknown as import("next/server").NextRequest;
}
const params = { params: Promise.resolve({ id: "o-1" }) };

function mockOwner(
  over: Partial<{
    name: string;
    nameKana: string | null;
    address: string | null;
    version: number;
    isArchived: boolean;
  }> = {},
) {
  pm.owner.findUnique.mockResolvedValue({
    id: "o-1",
    name: over.name ?? "山田太郎",
    nameKana: over.nameKana ?? null,
    address: over.address ?? null,
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
    expect(
      (await POST(req({ version: 1, field: "name", mode: "sanitize" }), params))
        .status,
    ).toBe(403);
  });

  it("owner:read 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce([
      { resource: "user_management", action: "read", granted: true },
    ]);
    expect(
      (await POST(req({ version: 1, field: "name", mode: "sanitize" }), params))
        .status,
    ).toBe(403);
  });

  it("実行時 owner:write 無しで 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RO);
    const res = await POST(
      req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
  });

  it("dryRun は owner:write 不要", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RO);
    const res = await POST(
      req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子" }),
      params,
    );
    expect(res.status).toBe(200);
  });

  it("owner:write ありでも field-level write 無しは実行 403", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RW_NO_FIELD);
    const res = await POST(
      req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });
});

describe("入力検証", () => {
  it("version 不正で 400", async () => {
    expect(
      (await POST(req({ field: "name", mode: "sanitize" }), params)).status,
    ).toBe(400);
  });
  it("field 不正（phone）で 400", async () => {
    expect(
      (await POST(req({ version: 1, field: "phone", mode: "sanitize" }), params))
        .status,
    ).toBe(400);
  });
  it("field=note は 400（note は audit-only・補正対象外）", async () => {
    expect(
      (await POST(req({ version: 1, field: "note", mode: "sanitize" }), params))
        .status,
    ).toBe(400);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });
  it("mode 不正で 400", async () => {
    expect(
      (await POST(req({ version: 1, field: "name", mode: "x" }), params)).status,
    ).toBe(400);
  });
  it("set で newValue 無しは 400", async () => {
    expect(
      (await POST(req({ version: 1, field: "name", mode: "set" }), params)).status,
    ).toBe(400);
  });
});

describe("not found", () => {
  it("owner 不存在で 404", async () => {
    pm.owner.findUnique.mockResolvedValueOnce(null);
    expect(
      (await POST(req({ version: 1, field: "name", mode: "sanitize" }), params))
        .status,
    ).toBe(404);
  });
});

describe("dryRun: eligible / blockReasons", () => {
  it("制御文字混入は sanitize で eligible", async () => {
    mockOwner({ name: `山田${SOH}太郎` });
    const json = await (
      await POST(req({ version: 1, field: "name", mode: "sanitize" }), params)
    ).json();
    expect(json.executed).toBe(false);
    expect(json.eligible).toBe(true);
    expect(json.blockReasons).toEqual([]);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("U+FFFD（audit-only）は sanitize 不可 → replacement_char", async () => {
    mockOwner({ name: `住所${FFFD}` });
    const json = await (
      await POST(req({ version: 1, field: "name", mode: "sanitize" }), params)
    ).json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("replacement_char");
  });

  it("クリーン値の sanitize は no_change", async () => {
    mockOwner({ name: "山田太郎" });
    const json = await (
      await POST(req({ version: 1, field: "name", mode: "sanitize" }), params)
    ).json();
    expect(json.blockReasons).toContain("no_change");
  });

  it("除去すると空になる制御文字のみは would_be_empty", async () => {
    mockOwner({ name: `${SOH}${SOH}` });
    const json = await (
      await POST(req({ version: 1, field: "name", mode: "sanitize" }), params)
    ).json();
    expect(json.blockReasons).toContain("would_be_empty");
  });

  it("set で再びゴミ（制御文字混入）は forbidden_value", async () => {
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: `山田${SOH}太郎` }),
        params,
      )
    ).json();
    expect(json.eligible).toBe(false);
    expect(json.blockReasons).toContain("forbidden_value");
  });

  it("set で U+FFFD 残存は forbidden_value", async () => {
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: `住所${FFFD}番地` }),
        params,
      )
    ).json();
    expect(json.blockReasons).toContain("forbidden_value");
  });

  it("set で version 不一致は version_mismatch", async () => {
    mockOwner({ name: "山田太郎", version: 3 });
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子" }),
        params,
      )
    ).json();
    expect(json.blockReasons).toContain("version_mismatch");
  });
});

describe("フィールド不可視ユーザーの dry-run hidden oracle 抑止", () => {
  it("sanitize + 制御文字現在値 + field masked は blockReasons を空にし eligible を出さない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ name: `${SOH}${SOH}`, version: 1 }); // 本来 would_be_empty
    const json = await (
      await POST(req({ version: 1, field: "name", mode: "sanitize" }), params)
    ).json();
    expect(json.executed).toBe(false);
    expect(json.blockReasons).toEqual([]);
    expect(json).not.toHaveProperty("eligible");
    expect(json.fieldVisible).toBe(false);
  });

  it("sanitize + version 不一致 + field masked でも version_mismatch を漏らさない（class オラクル）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ name: `山田${SOH}太郎`, version: 3 });
    const json = await (
      await POST(req({ version: 1, field: "name", mode: "sanitize" }), params)
    ).json();
    expect(json.blockReasons).not.toContain("version_mismatch");
    expect(json.blockReasons).toEqual([]);
    expect(json).not.toHaveProperty("eligible");
  });

  it("set + 同値 + field masked は no_change を漏らさない（eligible も出さない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ name: "山田太郎", version: 1 });
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: "山田太郎" }),
        params,
      )
    ).json();
    expect(json.blockReasons).not.toContain("no_change");
    expect(json).not.toHaveProperty("eligible");
    expect(json.fieldVisible).toBe(false);
  });

  it("set + 入力依存の forbidden_value は field masked でも出す（隠し値に依存しない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_MASKED);
    mockOwner({ name: "山田太郎", version: 1 });
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: `佐藤${SOH}花子` }),
        params,
      )
    ).json();
    expect(json.blockReasons).toContain("forbidden_value");
    expect(json).not.toHaveProperty("eligible");
  });

  it("field 可視（read）なら従来通り eligible / blockReasons を返す", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_FIELD_VISIBLE);
    mockOwner({ name: "山田太郎", version: 1 });
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: "山田太郎" }),
        params,
      )
    ).json();
    expect(json.blockReasons).toContain("no_change");
    expect(json.eligible).toBe(false);
    expect(json.fieldVisible).toBe(true);
  });
});

describe("実行 (dryRun=false)", () => {
  it("set 成功で更新・ChangeLog 記録・新 version", async () => {
    mockOwner({ name: "山田太郎", version: 1 });
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子", dryRun: false }),
        params,
      )
    ).json();
    expect(json.executed).toBe(true);
    expect(json.version).toBe(2);
    expect(json.updatedFields).toEqual(["name"]);

    expect(pm.owner.updateMany).toHaveBeenCalledOnce();
    const upd = pm.owner.updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "o-1", version: 1, isArchived: false });
    expect(upd.data.name).toBe("佐藤花子");

    const cl = pm.changeLog.createMany.mock.calls[0][0].data[0];
    expect(cl.fieldName).toBe("name");
    expect(cl.oldValue).toBe("山田太郎");
    expect(cl.newValue).toBe("佐藤花子");
  });

  it("sanitize 成功で制御文字を除いた値に更新", async () => {
    mockOwner({ name: `Yamada${SOH}Taro` });
    const json = await (
      await POST(
        req({ version: 1, field: "name", mode: "sanitize", dryRun: false }),
        params,
      )
    ).json();
    expect(json.executed).toBe(true);
    expect(pm.owner.updateMany.mock.calls[0][0].data.name).toBe("YamadaTaro");
  });

  it("address フィールドも補正できる（field パラメータ化）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RW_ADDRESS);
    mockOwner({ address: `東京${SOH}都` });
    const json = await (
      await POST(
        req({ version: 1, field: "address", mode: "sanitize", dryRun: false }),
        params,
      )
    ).json();
    expect(json.executed).toBe(true);
    expect(json.updatedFields).toEqual(["address"]);
    expect(pm.owner.updateMany.mock.calls[0][0].data.address).toBe("東京都");
  });

  it("AuditLog detail に生値が含まれない", async () => {
    mockOwner({ name: "山田太郎" });
    await POST(
      req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子", dryRun: false }),
      params,
    );
    const call = vi.mocked(writeAuditLog).mock.calls[0][0];
    expect(call.action).toBe("owner_correction_text_fix");
    const detailJson = JSON.stringify(call.detail);
    expect(detailJson).not.toContain("山田太郎");
    expect(detailJson).not.toContain("佐藤花子");
    expect(call.detail).toHaveProperty("updatedFields");
  });

  it("制御文字 set 値は実行でも DB 更新せずブロック（422 forbidden_value）", async () => {
    const res = await POST(
      req({ version: 1, field: "name", mode: "set", newValue: `山田${SOH}太郎`, dryRun: false }),
      params,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("forbidden_value");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("tx 内 updateMany count=0（version 競合）で 409", async () => {
    pm.owner.updateMany.mockResolvedValue({ count: 0 });
    pm.owner.findUnique
      .mockResolvedValueOnce({
        id: "o-1",
        name: "山田太郎",
        nameKana: null,
        address: null,
        version: 1,
        isArchived: false,
      }) // 初回ロード
      .mockResolvedValueOnce({ version: 2, isArchived: false }); // tx 内 recheck
    const res = await POST(
      req({ version: 1, field: "name", mode: "set", newValue: "佐藤花子", dryRun: false }),
      params,
    );
    expect(res.status).toBe(409);
    expect(pm.changeLog.createMany).not.toHaveBeenCalled();
  });
});
