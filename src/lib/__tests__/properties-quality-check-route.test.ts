/**
 * GET /api/properties/quality-check の統合テスト。
 * DB条件抽出 + summary=全体実件数(count) + ページング(rule/offset/limit) + rules メタ。
 *
 * 確認項目:
 *  1. あるルールで上限超でも summary は全体件数(count)・data は丸める
 *  2. 既定レスポンスに rules メタ（rule/severity/totalCount/returnedCount/offset/hasMore/nextOffset）が返る
 *  3. ?rule=CODE&offset=… で当該ルールの続きを skip/take で取得できる
 *  4. ページングは skip/take（全件findManyでJS sliceしない）
 *  5. 不正 rule は 400(INVALID_RULE)・DB未実行
 *  6. 不正 limit/offset を安全に扱う（limit は[1,1000]に丸め、offset 負値は0）
 *  7. 上限未満では rules[].hasMore=false
 *  8. errors/warnings/info/total は count(全体件数) から計算
 *  9. Owner PII を取得・返却しない（select は id/address のみ）
 * 10. property:read 欠如で 403・DB(count/findMany)未実行（両モード）
 * 11. isArchived=false 条件が各クエリで維持される
 * 12. route.ts は GET 以外を export しない
 *
 * permissions（hasPermission）は実物を使用し、api-helpers / prisma のみ mock する。
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
import * as routeModule from "../../app/api/properties/quality-check/route";

const { GET } = routeModule;

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
};

const PERMS_FULL = [{ resource: "property", action: "read", granted: true }];
const PERMS_NO_PROPERTY = [{ resource: "owner", action: "read", granted: true }];

type Where = Record<string, unknown>;
type Row = { id: string; address: string };
type RuleScenario = { count: number; sample: Row[] };
type RuleCode =
  | "NO_OWNER"
  | "REGISTRY_DM_MISMATCH"
  | "NO_LOT_NUMBER"
  | "NO_REAL_ESTATE_NUMBER"
  | "INVESTIGATION_NOT_CONFIRMED"
  | "NO_ASSIGNEE";
// TOTAL を rule code の index と分離する。
// 旧定義 `Partial<Record<string, RuleScenario>>` は string index が "TOTAL" キーまで
// RuleScenario に巻き込み、`TOTAL?: number` と矛盾して never 化していた（型を緩めず正す）。
type Scenario = { TOTAL?: number } & Partial<Record<RuleCode, RuleScenario>>;

function whereCode(where: Where): RuleCode | "TOTAL" {
  if (where.propertyOwners) return "NO_OWNER";
  if (where.registryStatus) return "REGISTRY_DM_MISMATCH";
  if (Array.isArray(where.OR)) {
    const firstKey = Object.keys(where.OR[0] as object)[0];
    if (firstKey === "lotNumber") return "NO_LOT_NUMBER";
    if (firstKey === "realEstateNumber") return "NO_REAL_ESTATE_NUMBER";
  }
  if ("investigationConfirmedAt" in where) return "INVESTIGATION_NOT_CONFIRMED";
  if ("assignedTo" in where) return "NO_ASSIGNEE";
  return "TOTAL";
}

function setup(scenario: Scenario) {
  pm.property.count.mockImplementation(async (args: { where: Where }) => {
    const code = whereCode(args.where);
    if (code === "TOTAL") return scenario.TOTAL ?? 0;
    return scenario[code]?.count ?? 0;
  });
  pm.property.findMany.mockImplementation(async (args: { where: Where }) => {
    const code = whereCode(args.where);
    if (code === "TOTAL") return [];
    return scenario[code]?.sample ?? [];
  });
}

function sampleRows(n: number, prefix: string): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    address: `addr-${prefix}${i}`,
  }));
}

function req(qs = ""): Request {
  return new Request(`http://localhost/api/properties/quality-check${qs}`);
}

function findManyCall(code: string) {
  return pm.property.findMany.mock.calls.find(
    (c) => whereCode(c[0].where) === code,
  )?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApiSession).mockResolvedValue({
    id: "user-1",
    role: "admin",
  } as never);
  vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as never);
  pm.property.count.mockResolvedValue(0);
  pm.property.findMany.mockResolvedValue([]);
});

describe("GET /api/properties/quality-check", () => {
  it("01. 上限超でも summary は全体件数(count)・data は丸める", async () => {
    setup({
      TOTAL: 9000,
      NO_OWNER: { count: 2500, sample: sampleRows(1000, "no") }, // warning
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.warnings).toBe(2500); // full count
    expect(
      body.data.filter((i: { code: string }) => i.code === "NO_OWNER"),
    ).toHaveLength(1000); // truncated
    expect(body.summary.issuesReturned).toBe(1000);
    expect(body.summary.issuesLimited).toBe(true);
  });

  it("02. 既定レスポンスに rules メタが返る（totalCount/hasMore/nextOffset 等）", async () => {
    setup({
      TOTAL: 9000,
      NO_OWNER: { count: 2500, sample: sampleRows(1000, "no") },
    });
    const res = await GET(req());
    const body = await res.json();
    const meta = body.rules.find(
      (r: { rule: string }) => r.rule === "NO_OWNER",
    );
    expect(meta).toMatchObject({
      rule: "NO_OWNER",
      severity: "warning",
      totalCount: 2500,
      returnedCount: 1000,
      offset: 0,
      hasMore: true,
      nextOffset: 1000,
    });
    // 全 6 ルール分のメタが返る
    expect(body.rules).toHaveLength(6);
  });

  it("03. ?rule=CODE&offset で当該ルールの続きを取得できる", async () => {
    setup({
      TOTAL: 9000,
      NO_LOT_NUMBER: { count: 2500, sample: sampleRows(1000, "lot") },
    });
    const res = await GET(req("?rule=NO_LOT_NUMBER&offset=1000"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 当該ルールの issue のみ
    expect(body.data.every((i: { code: string }) => i.code === "NO_LOT_NUMBER")).toBe(
      true,
    );
    expect(body.data).toHaveLength(1000);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({
      rule: "NO_LOT_NUMBER",
      offset: 1000,
      totalCount: 2500,
      returnedCount: 1000,
      hasMore: true, // 1000+1000 < 2500
      nextOffset: 2000,
    });
    // 既定モードの summary は付かない（ページングモード）
    expect(body.summary).toBeUndefined();
  });

  it("04. ページングは skip/take（全件findManyでJS sliceしない）", async () => {
    setup({ NO_LOT_NUMBER: { count: 2500, sample: sampleRows(10, "lot") } });
    await GET(req("?rule=NO_LOT_NUMBER&offset=1000"));
    const call = findManyCall("NO_LOT_NUMBER")!;
    expect(call.skip).toBe(1000);
    expect(call.take).toBe(1000); // limit 未指定 → 既定=最大1000
    expect(call.select).toEqual({ id: true, address: true });
    // 該当ルール以外の findMany は呼ばれない（全件取得していない）
    expect(pm.property.findMany.mock.calls).toHaveLength(1);
  });

  it("05. 不正 rule は 400(INVALID_RULE)・DB未実行", async () => {
    setup({ TOTAL: 10 });
    const res = await GET(req("?rule=NOPE"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_RULE");
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("06. 不正 limit/offset を安全に扱う（limitは[1,1000]丸め・offset負値は0）", async () => {
    setup({ NO_OWNER: { count: 5, sample: sampleRows(5, "x") } });
    await GET(req("?rule=NO_OWNER&limit=99999")); // 上限丸め
    expect(findManyCall("NO_OWNER")!.take).toBe(1000);

    vi.clearAllMocks();
    vi.mocked(getApiSession).mockResolvedValue({ id: "u", role: "admin" } as never);
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_FULL as never);
    setup({ NO_OWNER: { count: 5, sample: sampleRows(5, "x") } });
    await GET(req("?rule=NO_OWNER&offset=-5&limit=abc")); // offset負→0, limit不正→既定1000
    const call = findManyCall("NO_OWNER")!;
    expect(call.skip).toBe(0);
    expect(call.take).toBe(1000);
  });

  it("07. 上限未満では rules[].hasMore=false", async () => {
    setup({
      TOTAL: 100,
      NO_OWNER: { count: 5, sample: sampleRows(5, "x") },
    });
    const res = await GET(req());
    const body = await res.json();
    const meta = body.rules.find((r: { rule: string }) => r.rule === "NO_OWNER");
    expect(meta.hasMore).toBe(false);
    expect(meta.totalCount).toBe(5);
    expect(meta.returnedCount).toBe(5);
    expect(meta.nextOffset).toBeNull();
    expect(body.summary.issuesLimited).toBe(false);
  });

  it("08. errors/warnings/info/total が count(全体件数) から計算される", async () => {
    setup({
      TOTAL: 9000,
      REGISTRY_DM_MISMATCH: { count: 3, sample: sampleRows(3, "e") }, // error
      NO_OWNER: { count: 7, sample: sampleRows(7, "w") }, // warning
      NO_LOT_NUMBER: { count: 1500, sample: sampleRows(1000, "i") }, // info, 上限超
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.summary.errors).toBe(3);
    expect(body.summary.warnings).toBe(7);
    expect(body.summary.info).toBe(1500);
    expect(body.summary.total).toBe(1510);
    expect(body.summary.issuesReturned).toBe(3 + 7 + 1000);
  });

  it("09. Owner PII を取得・返却しない（select は id/address のみ）", async () => {
    setup({ NO_OWNER: { count: 1, sample: sampleRows(1, "x") } });
    const res = await GET(req());
    for (const call of pm.property.findMany.mock.calls) {
      expect(call[0].select).toEqual({ id: true, address: true });
      const s = JSON.stringify(call[0].select);
      expect(s).not.toContain("name");
      expect(s).not.toContain("zip");
      expect(s).not.toContain("phone");
      expect(s).not.toContain("email");
      expect(s).not.toContain("propertyOwners");
    }
    const body = await res.json();
    for (const issue of body.data) {
      expect(Object.keys(issue).sort()).toEqual(
        ["address", "code", "message", "propertyId", "severity"].sort(),
      );
    }
    expect(JSON.stringify(body)).not.toContain("ownerName");
  });

  it("10. property:read 欠如で 403・DB未実行（既定/ページング両モード）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as never);
    const res1 = await GET(req());
    expect(res1.status).toBe(403);
    const res2 = await GET(req("?rule=NO_OWNER&offset=0"));
    expect(res2.status).toBe(403);
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("11. isArchived=false が各クエリ(count/findMany・両モード)で維持される", async () => {
    setup({ TOTAL: 10, NO_OWNER: { count: 1, sample: sampleRows(1, "x") } });
    await GET(req()); // 既定
    await GET(req("?rule=NO_OWNER&offset=0")); // ページング
    for (const call of pm.property.count.mock.calls) {
      expect(call[0].where.isArchived).toBe(false);
    }
    for (const call of pm.property.findMany.mock.calls) {
      expect(call[0].where.isArchived).toBe(false);
    }
  });

  it("12. route.ts は GET 以外を export しない", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["GET"]);
  });
});
