/**
 * GET /api/properties/quality-check の統合テスト。
 * 性能改善（DB条件で「問題のある物件だけ」を取得）＋ Codex 追加P2対応
 * （物件総数 5000 件超でも 409 にせず 200 で完全な品質チェックを返す。全件 findMany には戻さない）。
 *
 * 確認項目:
 *  1. 非アーカイブ物件数が 5000 件超の想定でも 409 にならない（200）
 *  2. 全非アーカイブ物件数は count で取得され summary.propertiesChecked に反映される
 *  3. 所有者なし判定が relation filter propertyOwners:{none:{}} で行われる
 *  4. Owner の id 配列・所有者PII列を select しない（取得列は id/address のみ）
 *  5. 地番/不動産番号未入力など既存 issue 判定が従来と同じ DB 条件（null/空文字 等）になる
 *  6. 複数 issue が同じ物件にある場合、propertyId 単位でマージされる
 *  7. property:read 欠如で 403・DB 取得（count/findMany）未実行
 *  8. すべての品質チェッククエリで isArchived=false が維持される
 *  9. レスポンスに所有者名・所有者住所・郵便番号など Owner PII が入らない
 * 10. route.ts は GET ハンドラ以外を export しない
 * 11. ルール該当が上限超のとき issuesLimited=true（hard fail せず 200・該当ルールは丸める）
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

// route 側の where から、どの品質ルール向けのクエリかを判定する（呼び出し順に依存しない）。
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
  return "UNKNOWN";
}

// code -> 該当物件 {id,address}[] のシナリオで findMany を mock する。
function setupFindMany(scenario: Record<string, { id: string; address: string }[]>) {
  pm.property.findMany.mockImplementation(async (args: { where: Where }) => {
    const code = whereCode(args.where);
    return scenario[code] ?? [];
  });
}

function rows(n: number, prefix = "p"): { id: string; address: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    address: `addr-${prefix}${i}`,
  }));
}

function whereFor(code: string): Where | undefined {
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
  it("01. 非アーカイブ物件数が 5000 件超でも 409 にならず 200 を返す", async () => {
    pm.property.count.mockResolvedValue(8000);
    setupFindMany({ NO_OWNER: rows(3, "no") });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.data.length).toBe(3);
  });

  it("02. 全非アーカイブ件数は count で取得し summary.propertiesChecked に入る", async () => {
    pm.property.count.mockResolvedValue(8000);
    const res = await GET();
    const body = await res.json();
    expect(pm.property.count).toHaveBeenCalledTimes(1);
    expect(pm.property.count.mock.calls[0][0].where).toEqual({
      isArchived: false,
    });
    expect(body.summary.propertiesChecked).toBe(8000);
  });

  it("03. 所有者なし判定は propertyOwners:{none:{}} の relation filter で行う", async () => {
    setupFindMany({ NO_OWNER: rows(1, "x") });
    await GET();
    const w = whereFor("NO_OWNER")!;
    expect(w.propertyOwners).toEqual({ none: {} });
    expect(w.isArchived).toBe(false);
  });

  it("04. 取得列は id/address のみ。Owner の id 配列・PII 列を select しない", async () => {
    setupFindMany({ NO_OWNER: rows(1) });
    await GET();
    for (const call of pm.property.findMany.mock.calls) {
      expect(call[0].select).toEqual({ id: true, address: true });
      const selectStr = JSON.stringify(call[0].select);
      expect(selectStr).not.toContain("propertyOwners");
      expect(selectStr).not.toContain("name");
      expect(selectStr).not.toContain("zip");
      expect(selectStr).not.toContain("phone");
      expect(selectStr).not.toContain("email");
    }
  });

  it("05. 各 issue の DB 条件が旧 JS 判定と同値（null/空文字・enum 比較）", async () => {
    setupFindMany({});
    await GET();
    // 地番・不動産番号未入力 = null または空文字（旧 !field と同値）
    expect(whereFor("NO_LOT_NUMBER")!.OR).toEqual([
      { lotNumber: null },
      { lotNumber: "" },
    ]);
    expect(whereFor("NO_REAL_ESTATE_NUMBER")!.OR).toEqual([
      { realEstateNumber: null },
      { realEstateNumber: "" },
    ]);
    // 登記未取得 かつ DM送付可
    const reg = whereFor("REGISTRY_DM_MISMATCH")!;
    expect(reg.registryStatus).toBe("unconfirmed");
    expect(reg.dmStatus).toBe("send");
    // 調査未確認 / 担当者未設定 = null
    expect(whereFor("INVESTIGATION_NOT_CONFIRMED")!.investigationConfirmedAt).toBe(
      null,
    );
    expect(whereFor("NO_ASSIGNEE")!.assignedTo).toBe(null);
  });

  it("06. 複数 issue が同じ物件にある場合 propertyId 単位でマージされる", async () => {
    // 同一物件 dup が NO_OWNER / NO_ASSIGNEE / NO_LOT_NUMBER の3条件に該当
    const dup = [{ id: "dup", address: "addr-dup" }];
    setupFindMany({
      NO_OWNER: dup,
      NO_ASSIGNEE: dup,
      NO_LOT_NUMBER: dup,
    });
    const res = await GET();
    const body = await res.json();
    const dupIssues = body.data.filter(
      (i: { propertyId: string }) => i.propertyId === "dup",
    );
    expect(dupIssues).toHaveLength(3);
    const codes = dupIssues.map((i: { code: string }) => i.code).sort();
    expect(codes).toEqual(["NO_ASSIGNEE", "NO_LOT_NUMBER", "NO_OWNER"]);
  });

  it("07. property:read 欠如で 403・count/findMany 未実行", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(pm.property.count).not.toHaveBeenCalled();
    expect(pm.property.findMany).not.toHaveBeenCalled();
  });

  it("08. すべての品質チェッククエリで isArchived=false が維持される", async () => {
    setupFindMany({ NO_OWNER: rows(1) });
    await GET();
    expect(pm.property.count.mock.calls[0][0].where.isArchived).toBe(false);
    for (const call of pm.property.findMany.mock.calls) {
      expect(call[0].where.isArchived).toBe(false);
    }
  });

  it("09. レスポンスに Owner PII（氏名・所有者住所・郵便番号等）が入らない", async () => {
    setupFindMany({ NO_OWNER: [{ id: "p1", address: "東京都千代田区1-1" }] });
    const res = await GET();
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
    // summary は非PIIキーのみ
    expect(Object.keys(body.summary).sort()).toEqual(
      [
        "errors",
        "info",
        "issuesLimited",
        "propertiesChecked",
        "total",
        "warnings",
      ].sort(),
    );
  });

  it("10. route.ts は GET 以外を export しない", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["GET"]);
  });

  it("11. ルール該当が上限超なら issuesLimited=true（200・該当ルールは丸める）", async () => {
    // findMany は take: LIMIT+1 で呼ばれる。take から1001件返して上限超を再現。
    pm.property.findMany.mockImplementation(async (args: { where: Where; take: number }) => {
      if (whereCode(args.where) === "NO_LOT_NUMBER") {
        return rows(args.take, "lot"); // = LIMIT + 1 件
      }
      return [];
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.issuesLimited).toBe(true);
    // 丸められて LIMIT 件だけ issue 化される（take - 1）
    const lotIssues = body.data.filter(
      (i: { code: string }) => i.code === "NO_LOT_NUMBER",
    );
    const takeArg = pm.property.findMany.mock.calls.find(
      (c) => whereCode(c[0].where) === "NO_LOT_NUMBER",
    )![0].take;
    expect(lotIssues.length).toBe(takeArg - 1);
  });

  it("11b. 上限未満では issuesLimited=false", async () => {
    setupFindMany({ NO_OWNER: rows(5, "ok") });
    const res = await GET();
    const body = await res.json();
    expect(body.summary.issuesLimited).toBe(false);
  });
});
