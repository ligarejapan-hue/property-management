/**
 * GET /api/properties/quality-check の「全モード ロール別可視範囲」テスト（17-C）。
 *
 * PR #130 で scoped モード（?propertyIds=）には一覧APIと同じ field_staff 可視範囲
 * （propertyVisibilityScopeWhere）を適用済み。本修正で残っていた
 * 既定モード / ?rule= ページングモードにも同一スコープを適用し、
 * field_staff に不可視物件の id/address/件数が返らないことを固定する。
 *
 * 確認項目:
 *  1. 既定モード field_staff: propertiesChecked count / 各ルール count / 各ルール findMany の
 *     すべてに createdBy/assignedTo スコープが AND され、isArchived:false・take 等は従来どおり
 *  2. ruleページングモード field_staff: count（total）と findMany（rows）の両方にスコープが AND され、
 *     skip/take・orderBy は従来どおり＝不可視物件の id/address も total も漏れない
 *  3. 既定モード admin: AND なし＝従来どおり全体対象（回帰lock）
 *  4. ruleページングモード admin: AND なし（回帰lock）
 *  5. スコープ条件は一覧APIと同じ単一定義元（propertyVisibilityScopeWhere）
 *     （fragment 一致は quality-check-property-ids-scope.test.ts で buildPropertyListWhere
 *      実物 where と完全一致を lock 済み）
 *
 * scoped モードの UUID validation / field_staff scope / rule 優先は
 * quality-check-property-ids-scope.test.ts が引き続き固定する（本修正で不変）。
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    apiResponse: vi.fn((data: unknown, status = 200) =>
      Response.json(data as Record<string, unknown>, { status }),
    ),
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
  };
});

vi.mock("@/lib/prisma", () => ({
  default: { property: { findMany: vi.fn(), count: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { GET } from "../../app/api/properties/quality-check/route";
import { propertyVisibilityScopeWhere } from "../property-list-query";

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
};

const PERMS_FULL = [{ resource: "property", action: "read", granted: true }];

type Where = Record<string, unknown>;

const FS_SESSION = {
  id: "fs-1",
  email: "f@x",
  name: "FS",
  role: "field_staff",
};
// 一覧API（buildPropertyListWhere）が field_staff に積むスコープと同一 fragment。
// helper との同一性は propertyVisibilityScopeWhere の戻り値で直接検証する。
const FS_SCOPE = { OR: [{ createdBy: "fs-1" }, { assignedTo: "fs-1" }] };

function makeRequest(qs: string) {
  return new Request(`http://localhost/api/properties/quality-check${qs}`, {
    method: "GET",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "u1",
    email: "a@a",
    name: "A",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL);
  pm.property.findMany.mockResolvedValue([]);
  pm.property.count.mockResolvedValue(0);
});

describe("quality-check 既定モード — ロール別可視範囲", () => {
  it("field_staff: propertiesChecked / 各ルール count / 各ルール findMany すべてにスコープが AND される", async () => {
    vi.mocked(getApiSession).mockResolvedValue(FS_SESSION as never);
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);

    // count = propertiesChecked(1) + 各ルール(6) = 7 本すべてにスコープ
    expect(pm.property.count).toHaveBeenCalledTimes(7);
    for (const call of pm.property.count.mock.calls) {
      const where = (call[0] as { where: Where }).where;
      expect(where.isArchived).toBe(false);
      expect(where.AND).toEqual([FS_SCOPE]);
    }
    // findMany = 各ルール 6 本すべてにスコープ・take は従来どおり 1000
    expect(pm.property.findMany).toHaveBeenCalledTimes(6);
    for (const call of pm.property.findMany.mock.calls) {
      const args = call[0] as { where: Where; take?: number };
      expect(args.where.isArchived).toBe(false);
      expect(args.where.AND).toEqual([FS_SCOPE]);
      expect(args.take).toBe(1000);
    }
    // スコープ fragment は単一定義元 helper の戻り値そのもの
    expect(propertyVisibilityScopeWhere(FS_SESSION)).toEqual(FS_SCOPE);
  });

  it("admin: 既定モードは AND なし＝従来どおり全体対象（回帰lock）", async () => {
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    expect(pm.property.count).toHaveBeenCalledTimes(7);
    for (const call of pm.property.count.mock.calls) {
      expect((call[0] as { where: Where }).where.AND).toBeUndefined();
    }
    expect(pm.property.findMany).toHaveBeenCalledTimes(6);
    for (const call of pm.property.findMany.mock.calls) {
      expect((call[0] as { where: Where }).where.AND).toBeUndefined();
    }
  });
});

describe("quality-check ?rule= ページングモード — ロール別可視範囲", () => {
  it("field_staff: count（total）と findMany（rows）の両方にスコープが AND され、不可視物件が漏れない", async () => {
    vi.mocked(getApiSession).mockResolvedValue(FS_SESSION as never);
    pm.property.count.mockResolvedValue(5);
    pm.property.findMany.mockResolvedValue([
      { id: "550e8400-e29b-41d4-a716-446655440001", address: "A1" },
    ]);

    const res = await GET(makeRequest("?rule=NO_OWNER&offset=0&limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules[0].totalCount).toBe(5); // total も scoped count 由来

    expect(pm.property.count).toHaveBeenCalledTimes(1);
    const countWhere = (pm.property.count.mock.calls[0][0] as { where: Where })
      .where;
    expect(countWhere.isArchived).toBe(false);
    expect(countWhere.propertyOwners).toBeDefined(); // NO_OWNER 述語は従来どおり
    expect(countWhere.AND).toEqual([FS_SCOPE]);

    expect(pm.property.findMany).toHaveBeenCalledTimes(1);
    const args = pm.property.findMany.mock.calls[0][0] as {
      where: Where;
      skip?: number;
      take?: number;
    };
    expect(args.where.AND).toEqual([FS_SCOPE]);
    expect(args.skip).toBe(0); // skip/take ページングは従来どおり
    expect(args.take).toBe(10);
  });

  it("admin: ページングモードは AND なし＝従来どおり全体対象（回帰lock）", async () => {
    pm.property.count.mockResolvedValue(1);
    pm.property.findMany.mockResolvedValue([]);
    const res = await GET(makeRequest("?rule=NO_ASSIGNEE"));
    expect(res.status).toBe(200);
    expect(
      (pm.property.count.mock.calls[0][0] as { where: Where }).where.AND,
    ).toBeUndefined();
    expect(
      (pm.property.findMany.mock.calls[0][0] as { where: Where }).where.AND,
    ).toBeUndefined();
  });

  it("field_staff: 不正 rule は従来どおり 400 INVALID_RULE・DB 未実行（スコープ追加で変質しない）", async () => {
    vi.mocked(getApiSession).mockResolvedValue(FS_SESSION as never);
    const res = await GET(makeRequest("?rule=UNKNOWN_RULE"));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_RULE");
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });
});
