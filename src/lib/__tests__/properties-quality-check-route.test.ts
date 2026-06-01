/**
 * GET /api/properties/quality-check の統合テスト。
 * 性能改善（DB条件で問題物件だけ抽出）＋ Codex P2: summary を「全体実件数(count)」化。
 *
 * 確認項目:
 *  1. あるルールで上限超(>QUALITY_CHECK_ISSUE_LIMIT)の場合、data(issues) は丸められても
 *     summary の該当 severity 件数は「全体件数(count)」になる
 *  2. errors / warnings / info が truncate 後 issues ではなく count(全体件数) から計算される
 *  3. 上限超のとき issuesLimited=true（非PII・hard fail しない・200）
 *  4. 上限未満では summary 件数と issues(data) が一致する（issuesReturned===total）
 *  5. Owner PII を取得・返却しない（select は id/address のみ）
 *  6. property:read 欠如で 403・DB(count/findMany)未実行
 *  7. 各品質ルールのクエリ（count/findMany）で isArchived=false が維持される
 *  8. 全件 findMany に戻っていない（各 findMany が rule 条件付き・無条件全件取得しない）
 *  9. route.ts は GET ハンドラ以外を export しない
 * 10. propertiesChecked は全非アーカイブ件数(count)。物件総数 5000 件超でも 409 にならない
 * 11. 同一物件が複数ルールに該当する場合 data は propertyId 単位でマージされる
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
type Scenario = { TOTAL?: number } & Partial<Record<string, RuleScenario>>;

// route 側の where から、どの品質ルール向け（または全件 TOTAL）かを判定する。
function whereCode(where: Where): string {
  if (where.propertyOwners) return "NO_OWNER";
  if (where.registryStatus) return "REGISTRY_DM_MISMATCH";
  if (Array.isArray(where.OR)) {
    const firstKey = Object.keys(where.OR[0] as object)[0];
    if (firstKey === "lotNumber") return "NO_LOT_NUMBER";
    if (firstKey === "realEstateNumber") return "NO_REAL_ESTATE_NUMBER";
  }
  if ("investigationConfirmedAt" in where) return "INVESTIGATION_NOT_CONFIRMED";
  if ("assignedTo" in where) return "NO_ASSIGNEE";
  return "TOTAL"; // rule キーを持たない = 全非アーカイブ件数のクエリ
}

function setup(scenario: Scenario) {
  pm.property.count.mockImplementation(async (args: { where: Where }) => {
    const code = whereCode(args.where);
    if (code === "TOTAL") return scenario.TOTAL ?? 0;
    return scenario[code]?.count ?? 0;
  });
  pm.property.findMany.mockImplementation(async (args: { where: Where }) => {
    const code = whereCode(args.where);
    return scenario[code]?.sample ?? [];
  });
}

function sampleRows(n: number, prefix: string): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    address: `addr-${prefix}${i}`,
  }));
}

function whereForFindMany(code: string): Where | undefined {
  const call = pm.property.findMany.mock.calls.find(
    (c) => whereCode(c[0].where) === code,
  );
  return call?.[0].where as Where | undefined;
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
  it("01. 上限超のルールでも summary は全体件数(count)・data は丸める", async () => {
    setup({
      TOTAL: 9000,
      // NO_OWNER は warning。全体 2500 件だが表示用 sample は上限1000件。
      NO_OWNER: { count: 2500, sample: sampleRows(1000, "no") },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // summary は全体件数（truncate後の1000ではなく2500）
    expect(body.summary.warnings).toBe(2500);
    // data は上限で丸められている
    const noOwner = body.data.filter(
      (i: { code: string }) => i.code === "NO_OWNER",
    );
    expect(noOwner).toHaveLength(1000);
    expect(body.summary.issuesReturned).toBe(1000);
    expect(body.summary.issuesLimited).toBe(true);
  });

  it("02. errors/warnings/info/total が count(全体件数) から計算される", async () => {
    setup({
      TOTAL: 9000,
      REGISTRY_DM_MISMATCH: { count: 3, sample: sampleRows(3, "err") }, // error
      NO_OWNER: { count: 7, sample: sampleRows(7, "ow") }, // warning
      NO_LOT_NUMBER: { count: 1500, sample: sampleRows(1000, "lot") }, // info, 上限超
    });
    const res = await GET();
    const body = await res.json();
    expect(body.summary.errors).toBe(3);
    expect(body.summary.warnings).toBe(7);
    expect(body.summary.info).toBe(1500);
    expect(body.summary.total).toBe(3 + 7 + 1500);
    // data は info 分だけ丸められる: 3 + 7 + 1000
    expect(body.summary.issuesReturned).toBe(3 + 7 + 1000);
    expect(body.data.length).toBe(3 + 7 + 1000);
    expect(body.summary.issuesLimited).toBe(true);
  });

  it("03. 上限超で issuesLimited=true（常に 200）", async () => {
    setup({
      TOTAL: 5000,
      NO_LOT_NUMBER: { count: 1001, sample: sampleRows(1000, "lot") },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.issuesLimited).toBe(true);
    expect(body.summary.issueLimit).toBe(1000);
  });

  it("04. 上限未満では summary 件数と data が一致（issuesReturned===total）", async () => {
    setup({
      TOTAL: 100,
      REGISTRY_DM_MISMATCH: { count: 2, sample: sampleRows(2, "e") }, // error
      NO_OWNER: { count: 5, sample: sampleRows(5, "w") }, // warning
    });
    const res = await GET();
    const body = await res.json();
    expect(body.summary.issuesLimited).toBe(false);
    expect(body.summary.errors).toBe(2);
    expect(body.summary.warnings).toBe(5);
    expect(body.summary.info).toBe(0);
    expect(body.summary.total).toBe(7);
    expect(body.summary.issuesReturned).toBe(7);
    expect(body.data.length).toBe(7);
  });

  it("05. Owner PII を取得・返却しない（select は id/address のみ）", async () => {
    setup({ NO_OWNER: { count: 1, sample: sampleRows(1, "x") } });
    const res = await GET();
    for (const call of pm.property.findMany.mock.calls) {
      expect(call[0].select).toEqual({ id: true, address: true });
      const selectStr = JSON.stringify(call[0].select);
      expect(selectStr).not.toContain("propertyOwners");
      expect(selectStr).not.toContain("name");
      expect(selectStr).not.toContain("zip");
      expect(selectStr).not.toContain("phone");
      expect(selectStr).not.toContain("email");
    }
    const body = await res.json();
    for (const issue of body.data) {
      expect(Object.keys(issue).sort()).toEqual(
        ["address", "code", "message", "propertyId", "severity"].sort(),
      );
    }
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("ownerName");
    expect(bodyStr).not.toContain("nameKana");
    expect(bodyStr).not.toContain("propertyOwners");
  });

  it("06. property:read 欠如で 403・count/findMany 未実行", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("07. 各品質ルールのクエリ(count/findMany)で isArchived=false が維持される", async () => {
    setup({ TOTAL: 10, NO_OWNER: { count: 1, sample: sampleRows(1, "x") } });
    await GET();
    for (const call of pm.property.count.mock.calls) {
      expect(call[0].where.isArchived).toBe(false);
    }
    for (const call of pm.property.findMany.mock.calls) {
      expect(call[0].where.isArchived).toBe(false);
    }
    // DB 条件の同値性（旧 JS 判定と一致）
    expect(whereForFindMany("NO_OWNER")!.propertyOwners).toEqual({ none: {} });
    expect(whereForFindMany("NO_LOT_NUMBER")!.OR).toEqual([
      { lotNumber: null },
      { lotNumber: "" },
    ]);
    const reg = whereForFindMany("REGISTRY_DM_MISMATCH")!;
    expect(reg.registryStatus).toBe("unconfirmed");
    expect(reg.dmStatus).toBe("send");
  });

  it("08. 全件 findMany に戻っていない（各 findMany が rule 条件付き）", async () => {
    setup({ TOTAL: 10 });
    await GET();
    // findMany はルール数だけ呼ばれ、すべて rule 条件を持つ（無条件 {isArchived:false} 単独はない）
    expect(pm.property.findMany.mock.calls.length).toBe(6);
    for (const call of pm.property.findMany.mock.calls) {
      expect(whereCode(call[0].where)).not.toBe("TOTAL");
    }
    // 全体件数は count で取得している（findMany で全件取得していない）
    const totalCountCall = pm.property.count.mock.calls.find(
      (c) => whereCode(c[0].where) === "TOTAL",
    );
    expect(totalCountCall).toBeDefined();
  });

  it("09. route.ts は GET 以外を export しない", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["GET"]);
  });

  it("10. propertiesChecked は count。物件総数 5000 件超でも 409 にならない", async () => {
    setup({ TOTAL: 8000, NO_OWNER: { count: 3, sample: sampleRows(3, "x") } });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.summary.propertiesChecked).toBe(8000);
    const totalCountCall = pm.property.count.mock.calls.find(
      (c) => whereCode(c[0].where) === "TOTAL",
    )!;
    expect(totalCountCall[0].where).toEqual({ isArchived: false });
  });

  it("11. 同一物件が複数ルールに該当する場合 data は propertyId 単位でマージ", async () => {
    const dup = [{ id: "dup", address: "addr-dup" }];
    setup({
      TOTAL: 10,
      NO_OWNER: { count: 1, sample: dup },
      NO_ASSIGNEE: { count: 1, sample: dup },
      NO_LOT_NUMBER: { count: 1, sample: dup },
    });
    const res = await GET();
    const body = await res.json();
    const dupIssues = body.data.filter(
      (i: { propertyId: string }) => i.propertyId === "dup",
    );
    expect(dupIssues).toHaveLength(3);
    expect(dupIssues.map((i: { code: string }) => i.code).sort()).toEqual(
      ["NO_ASSIGNEE", "NO_LOT_NUMBER", "NO_OWNER"],
    );
  });
});
