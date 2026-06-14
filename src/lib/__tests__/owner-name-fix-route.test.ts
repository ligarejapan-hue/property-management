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
  { resource: "owner_name", action: "full", granted: true },
];
const PERMS_RO = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
];
// owner:write はあるが owner_name の field-level write（full/edit）が無い。
const PERMS_RW_NO_NAME = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner", action: "write", granted: true },
  { resource: "owner_name", action: "masked", granted: true },
];
// owner:read / user_management:read はあるが owner_name が masked（氏名生値が不可視）。
// dryRun preview しかできない（owner:write も無い）。
const PERMS_RO_NAME_MASKED = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "masked", granted: true },
];
// owner_name=read（氏名生値が可視）。
const PERMS_RO_NAME_VISIBLE = [
  { resource: "user_management", action: "read", granted: true },
  { resource: "owner", action: "read", granted: true },
  { resource: "owner_name", action: "read", granted: true },
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

  it("owner:write はあるが owner_name の field-level write 無しは実行 403（P1）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RW_NO_NAME);
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_name write 無しでも sanitize 実行は 403（P1）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RW_NO_NAME);
    mockOwner({ name: "Yamada" + SOH + "Taro" });
    const res = await POST(
      req({ version: 1, mode: "sanitize", dryRun: false }),
      params,
    );
    expect(res.status).toBe(403);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_name write 無しでも dryRun（preview）は 200（P1: 読み取りは許可）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValueOnce(PERMS_RW_NO_NAME);
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎" }),
      params,
    );
    expect(res.status).toBe(200);
  });
});

describe("氏名不可視ユーザーの dry-run は同値オラクルを出さない（P1）", () => {
  it("owner_name 不可視 + set で current と一致しても no_change を漏らさない（eligible も出さない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    mockOwner({ name: "山田太郎", version: 1 });
    // 隠れた現在値（山田太郎）と一致する値を当てに来ても no_change を返さない。
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.blockReasons).not.toContain("no_change");
    // 一致/不一致を判別させない: eligible も伏せる。
    expect(json).not.toHaveProperty("eligible");
    expect(json.nameVisible).toBe(false);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("owner_name 不可視 + set で current と不一致でも eligible/no_change を出さない（P1）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    mockOwner({ name: "山田太郎", version: 1 });
    const res = await POST(
      req({ version: 1, mode: "set", newName: "佐藤花子" }),
      params,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.blockReasons).not.toContain("no_change");
    expect(json).not.toHaveProperty("eligible");
    expect(json.nameVisible).toBe(false);
  });

  it("owner_name 不可視でも入力依存の forbidden_value は出す（隠し値に依存しない）（P1）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    mockOwner({ name: "山田太郎", version: 1 });
    const res = await POST(
      req({ version: 1, mode: "set", newName: "999" }),
      params,
    );
    const json = await res.json();
    expect(json.blockReasons).toContain("forbidden_value");
    expect(json.blockReasons).not.toContain("no_change");
    expect(json).not.toHaveProperty("eligible");
  });

  it("owner_name 可視（read）なら従来通り no_change / eligible を返す", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_VISIBLE);
    mockOwner({ name: "山田太郎", version: 1 });
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田太郎" }),
      params,
    );
    const json = await res.json();
    expect(json.blockReasons).toContain("no_change");
    expect(json.eligible).toBe(false);
    expect(json.nameVisible).toBe(true);
  });
});

describe("氏名不可視ユーザーの sanitize dry-run は現在値由来理由を漏らさない（P1）", () => {
  it("sanitize + 数値ゴミ現在値でも no_safe_autofix を漏らさない（eligible も出さない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    mockOwner({ name: "44225", version: 1 }); // 数値ゴミ → 本来 no_safe_autofix
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.executed).toBe(false);
    expect(json.blockReasons).not.toContain("no_safe_autofix");
    expect(json).not.toHaveProperty("eligible");
    expect(json.nameVisible).toBe(false);
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
  });

  it("sanitize + 制御文字のみ現在値でも name_would_be_empty を漏らさない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    // 制御文字のみ（除去すると空）→ 本来 name_would_be_empty
    mockOwner({ name: SOH + SOH, version: 1 });
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    expect(json.blockReasons).not.toContain("name_would_be_empty");
    expect(json.blockReasons).not.toContain("no_safe_autofix");
    expect(json).not.toHaveProperty("eligible");
    expect(json.nameVisible).toBe(false);
  });

  it("sanitize + 既に整形済み現在値でも no_change を漏らさない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    mockOwner({ name: "山田太郎", version: 1 }); // sanitize で無変更 → 本来 no_change
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    expect(json.blockReasons).not.toContain("no_change");
    expect(json).not.toHaveProperty("eligible");
  });

  it("sanitize + 救える現在値（制御文字混入）でも eligible/空リストで確定情報を漏らさない", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    // 制御文字混入だが文字も残る → 本来 eligible=true / blockReasons=[]
    mockOwner({ name: "Yamada" + SOH + "Taro", version: 1 });
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    // eligible を出さない（救える＝隠し値が制御文字混入だと推測されてしまう）
    expect(json).not.toHaveProperty("eligible");
    expect(json.blockReasons).toEqual([]);
    expect(json.nameVisible).toBe(false);
  });

  it("sanitize + version 不一致は version_mismatch を保持する（氏名生値を漏らさない）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_MASKED);
    mockOwner({ name: "Yamada" + SOH + "Taro", version: 3 });
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("version_mismatch");
    expect(json).not.toHaveProperty("eligible");
  });

  it("可視ユーザーの sanitize は従来通り no_safe_autofix / eligible を返す（過剰抑止なし）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_RO_NAME_VISIBLE);
    mockOwner({ name: "44225", version: 1 });
    const res = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json = await res.json();
    expect(json.blockReasons).toContain("no_safe_autofix");
    expect(json.eligible).toBe(false);
    expect(json.nameVisible).toBe(true);

    // 救えるケースは eligible=true（従来通り）
    mockOwner({ name: "Yamada" + SOH + "Taro", version: 1 });
    const res2 = await POST(req({ version: 1, mode: "sanitize" }), params);
    const json2 = await res2.json();
    expect(json2.eligible).toBe(true);
    expect(json2.blockReasons).toEqual([]);
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

  it("set 値に制御文字混入は forbidden_value（P2）", async () => {
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田" + SOH + "太郎" }),
      params,
    );
    const json = await res.json();
    expect(json.eligible).toBe(false);
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

  it("制御文字 set 値は実行でも DB 更新せずブロック（P2）", async () => {
    const res = await POST(
      req({ version: 1, mode: "set", newName: "山田" + SOH + "太郎", dryRun: false }),
      params,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.blockReasons).toContain("forbidden_value");
    expect(pm.owner.updateMany).not.toHaveBeenCalled();
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
