/**
 * GET /api/properties/quality-check の scoped モード（?propertyIds=）の統合テスト（17-C F2）。
 *
 * 確認項目:
 *  1. scoped: 各ルール findMany の where に id:{in:ids} + isArchived:false が必ず入る（PK IN で有界）
 *  2. scoped: per-rule count を発行しない（count は warningPropertiesTotal の 1 本のみ）
 *  3. scoped: warningPropertiesTotal の where は「error/warning ルールの OR」（info ルールを含まない）
 *  4. scoped: findMany に take を付けない（1000 件サンプリングをしない）
 *  5. scoped: data は propertyId 単位マージ・rules は hasMore=false / totalCount=実数
 *  6. propertyIds の trim / 空要素除去 / 重複除去
 *  7. propertyIds が 0 件 → findMany 不発行・count 1 本のみ・data 空
 *  8. 上限超過（>200）→ 400 INVALID_PROPERTY_IDS・DB 未実行
 *  9. ?rule= ページングモードが優先され propertyIds は無視される（where に id が入らない）
 * 10. 既定モード（propertyIds なし）は where に id が入らない（従来挙動の回帰防止）
 * 11. property:read 欠如で 403・DB 未実行
 * 12. 一覧ページ側の配線（ソース表明）: scoped 呼び出し・[properties] 依存・補完ボタン撤去・チップは全体実数
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import fs from "fs";
import path from "path";

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

const pm = prisma as unknown as {
  property: { findMany: Mock; count: Mock };
};

const PERMS_FULL = [{ resource: "property", action: "read", granted: true }];
const PERMS_NO_PROPERTY = [{ resource: "owner", action: "read", granted: true }];

type Where = Record<string, unknown>;

// 各ルール where の識別（properties-quality-check-route.test.ts と同方式）。
function ruleCode(where: Where): string {
  if (where.propertyOwners) return "NO_OWNER";
  if (where.registryStatus) return "REGISTRY_DM_MISMATCH";
  if (Array.isArray(where.OR) && !("propertyOwners" in (where.OR[0] as object))) {
    const firstKey = Object.keys(where.OR[0] as object)[0];
    if (firstKey === "lotNumber") return "NO_LOT_NUMBER";
    if (firstKey === "realEstateNumber") return "NO_REAL_ESTATE_NUMBER";
  }
  if ("investigationConfirmedAt" in where) return "INVESTIGATION_NOT_CONFIRMED";
  if ("assignedTo" in where) return "NO_ASSIGNEE";
  return "OTHER";
}

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

describe("quality-check scoped モード（?propertyIds=）", () => {
  it("各ルール findMany に id:{in} + isArchived:false が入り take なし・per-rule count なし", async () => {
    pm.property.count.mockResolvedValue(42); // warningPropertiesTotal
    pm.property.findMany.mockImplementation(async ({ where }: { where: Where }) => {
      // p1 は NO_OWNER と NO_ASSIGNEE の両方に該当（マージ確認用）
      const code = ruleCode(where);
      if (code === "NO_OWNER") return [{ id: "p1", address: "A1" }];
      if (code === "NO_ASSIGNEE") return [{ id: "p1", address: "A1" }];
      if (code === "REGISTRY_DM_MISMATCH") return [{ id: "p2", address: "A2" }];
      return [];
    });

    const res = await GET(makeRequest("?propertyIds=p1,p2"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // 6 ルールぶんの findMany すべてに id:{in:["p1","p2"]} と isArchived:false、take なし
    expect(pm.property.findMany).toHaveBeenCalledTimes(6);
    for (const call of pm.property.findMany.mock.calls) {
      const args = call[0] as { where: Where; take?: number; select: Where };
      expect(args.where.id).toEqual({ in: ["p1", "p2"] });
      expect(args.where.isArchived).toBe(false);
      expect(args.take).toBeUndefined();
      expect(args.select).toEqual({ id: true, address: true });
    }

    // count は warningPropertiesTotal の 1 本のみ（per-rule count なし）
    expect(pm.property.count).toHaveBeenCalledTimes(1);
    const countWhere = pm.property.count.mock.calls[0][0].where as Where;
    expect(countWhere.isArchived).toBe(false);
    const orList = countWhere.OR as Where[];
    expect(orList).toHaveLength(4); // error/warning の 4 ルールのみ
    const orCodes = orList.map((w) => ruleCode(w));
    expect(orCodes).toEqual(
      expect.arrayContaining([
        "NO_OWNER",
        "REGISTRY_DM_MISMATCH",
        "INVESTIGATION_NOT_CONFIRMED",
        "NO_ASSIGNEE",
      ]),
    );
    // info ルール（地番/不動産番号）を含まない
    expect(orCodes).not.toContain("NO_LOT_NUMBER");
    expect(orCodes).not.toContain("NO_REAL_ESTATE_NUMBER");
    // count where 自体には id 制約なし（全体実数）
    expect(countWhere.id).toBeUndefined();

    // レスポンス: p1 はマージで 2 issue、p2 は 1 issue
    expect(body.data).toHaveLength(3);
    expect(body.warningPropertiesTotal).toBe(42);
    expect(body.scope).toEqual({ propertyIds: 2 });
    expect(body.summary.issuesLimited).toBe(false);
    expect(body.summary.propertiesChecked).toBe(2);
    // rules は全ルール hasMore=false / totalCount=実数
    expect(body.rules).toHaveLength(6);
    for (const meta of body.rules) {
      expect(meta.hasMore).toBe(false);
      expect(meta.nextOffset).toBeNull();
    }
    const noOwnerMeta = body.rules.find(
      (r: { rule: string }) => r.rule === "NO_OWNER",
    );
    expect(noOwnerMeta.totalCount).toBe(1);
  });

  it("propertyIds は trim / 空要素除去 / 重複除去される", async () => {
    pm.property.count.mockResolvedValue(0);
    await GET(makeRequest("?propertyIds=" + encodeURIComponent(" p1 , ,p2,p1,")));
    expect(pm.property.findMany).toHaveBeenCalledTimes(6);
    const args = pm.property.findMany.mock.calls[0][0] as { where: Where };
    expect(args.where.id).toEqual({ in: ["p1", "p2"] });
  });

  it("propertyIds が 0 件 → findMany 不発行・count 1 本のみ・data 空", async () => {
    pm.property.count.mockResolvedValue(7);
    const res = await GET(makeRequest("?propertyIds="));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(pm.property.count).toHaveBeenCalledTimes(1);
    expect(body.data).toEqual([]);
    expect(body.warningPropertiesTotal).toBe(7);
    expect(body.scope).toEqual({ propertyIds: 0 });
    expect(body.summary.total).toBe(0);
  });

  it("上限超過（201件）→ 400 INVALID_PROPERTY_IDS・DB 未実行", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`).join(",");
    const res = await GET(makeRequest(`?propertyIds=${ids}`));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_PROPERTY_IDS");
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(pm.property.count).not.toHaveBeenCalled();
  });

  it("?rule= ページングモードが優先され propertyIds は無視される", async () => {
    pm.property.count.mockResolvedValue(1);
    pm.property.findMany.mockResolvedValue([{ id: "p9", address: "A9" }]);
    const res = await GET(makeRequest("?rule=NO_OWNER&propertyIds=p1,p2"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rules).toHaveLength(1);
    // ページングモードのクエリ where に id 制約が入らない
    for (const call of pm.property.findMany.mock.calls) {
      expect((call[0] as { where: Where }).where.id).toBeUndefined();
    }
    expect((pm.property.count.mock.calls[0][0] as { where: Where }).where.id).toBeUndefined();
  });

  it("既定モード（propertyIds なし）は where に id が入らない（回帰防止）", async () => {
    await GET(makeRequest(""));
    expect(pm.property.findMany).toHaveBeenCalledTimes(6);
    for (const call of pm.property.findMany.mock.calls) {
      const args = call[0] as { where: Where; take?: number };
      expect(args.where.id).toBeUndefined();
      expect(args.take).toBe(1000); // 既定モードは従来どおり take あり
    }
    expect(pm.property.count).toHaveBeenCalledTimes(7); // NOT_ARCHIVED + 6 ルール
  });

  it("property:read 欠如 → 403・DB 未実行（scoped モード）", async () => {
    vi.mocked(getUserPermissions).mockResolvedValue(PERMS_NO_PROPERTY);
    const res = await GET(makeRequest("?propertyIds=p1"));
    expect(res.status).toBe(403);
    expect(pm.property.findMany).not.toHaveBeenCalled();
    expect(pm.property.count).not.toHaveBeenCalled();
  });
});

// ---------- 一覧ページ側の配線（ソース表明）----------

describe("properties 一覧の警告バッジ配線（F2・ソース表明）", () => {
  const pageSrc = fs.readFileSync(
    path.join(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
    "utf8",
  );
  const apiClientSrc = fs.readFileSync(
    path.join(process.cwd(), "src/lib/api-client.ts"),
    "utf8",
  );

  it("バッジ取得は表示中 propertyIds に scope され properties に追従する", () => {
    expect(pageSrc).toMatch(
      /fetchQualityCheck\(\{\s*propertyIds:\s*properties\.map\(\(p\)\s*=>\s*p\.id\),?\s*\}\)/,
    );
    // 警告バッジ effect の deps が [properties]（mount 1回方式に戻っていない）
    expect(pageSrc).toMatch(/\}, \[properties\]\);/);
  });

  it("旧・全域取得の補完 UI（残りの警告を読み込む）は撤去済み", () => {
    expect(pageSrc).not.toMatch(/loadRemainingWarnings/);
    expect(pageSrc).not.toMatch(/warningsTruncated/);
    expect(pageSrc).not.toMatch(/fetchQualityCheck\(\)/); // 無引数の全域呼び出しが残っていない
  });

  it("「警告ありのみ」チップは warningPropertiesTotal 由来の全体実数を表示する", () => {
    expect(pageSrc).toMatch(/warningPropertyCount/);
    expect(pageSrc).toMatch(/warningPropertiesTotal/);
    // チップが「現在ページの warnings Map サイズ」表示に戻っていない
    expect(pageSrc).not.toMatch(/warningsByProperty\.size/);
  });

  it("api-client fetchQualityCheck は propertyIds をカンマ結合で送る", () => {
    expect(apiClientSrc).toMatch(/propertyIds\?\:\s*string\[\]/);
    expect(apiClientSrc).toMatch(
      /qs\.set\("propertyIds",\s*params\.propertyIds\.join\(","\)\)/,
    );
  });
});
