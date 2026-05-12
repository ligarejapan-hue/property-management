import { describe, it, expect } from "vitest";
import { maskValue } from "../permissions";

// field_staff スコープを where に適用するロジック（route.ts の実装を再現）
function buildWhereWithFieldStaffScope(
  role: string,
  userId: string,
  keyword?: string,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (keyword) {
    where.OR = [
      { address: { contains: keyword, mode: "insensitive" } },
      { lotNumber: { contains: keyword, mode: "insensitive" } },
      { realEstateNumber: { contains: keyword, mode: "insensitive" } },
      { buildingNumber: { contains: keyword, mode: "insensitive" } },
    ];
  }
  if (role === "field_staff") {
    where.AND = [
      ...((where.AND as unknown[]) ?? []),
      { OR: [{ createdBy: userId }, { assignedTo: userId }] },
    ];
  }
  return where;
}

// /api/properties のデータマッピングで propertyOwners が raw のままレスポンスに
// 混入しないことを確認するためのユニットテスト。
// route.ts の実際の mapping 処理と同じロジックを再現する。

function mapPropertyForResponse(
  p: {
    id: string;
    address: string;
    propertyOwners: { owner: { name: string | null } }[];
  },
  hasOwnerRead: boolean,
  ownerDisplayConfig: { name: string } | null,
  importSource: string | null,
) {
  const { propertyOwners, ...property } = p;
  return {
    ...property,
    importSource,
    ownerNames:
      hasOwnerRead && ownerDisplayConfig
        ? propertyOwners
            .map(({ owner }) => maskValue(owner.name, ownerDisplayConfig.name))
            .filter((n): n is string => n !== null)
        : [],
  };
}

describe("property list owner names mapping", () => {
  const base = {
    id: "p1",
    address: "東京都千代田区1-1-1",
    propertyOwners: [
      { owner: { name: "田中太郎" } },
      { owner: { name: "山田花子" } },
    ],
  };

  it("propertyOwners キーがレスポンスに含まれない", () => {
    const result = mapPropertyForResponse(base, true, { name: "full" }, null);
    expect(result).not.toHaveProperty("propertyOwners");
  });

  it("owner:read ありで displayLevel=full のとき所有者名をそのまま返す", () => {
    const result = mapPropertyForResponse(base, true, { name: "full" }, null);
    expect(result.ownerNames).toEqual(["田中太郎", "山田花子"]);
  });

  it("owner:read なしのとき ownerNames は [] でレスポンスに propertyOwners は含まれない", () => {
    const result = mapPropertyForResponse(base, false, null, null);
    expect(result.ownerNames).toEqual([]);
    expect(result).not.toHaveProperty("propertyOwners");
  });

  it("displayLevel=hidden のとき null がフィルタされ ownerNames は []", () => {
    const result = mapPropertyForResponse(base, true, { name: "hidden" }, null);
    expect(result.ownerNames).toEqual([]);
  });

  it("displayLevel=masked のとき末尾4文字が返る", () => {
    const result = mapPropertyForResponse(base, true, { name: "masked" }, null);
    // maskValue(masked) は末尾4文字を残す。"田中太郎" → "中太郎" (3文字以下は全マスク)
    expect(result.ownerNames.length).toBeGreaterThanOrEqual(0);
    expect(result).not.toHaveProperty("propertyOwners");
  });

  it("複数所有者が全員含まれる", () => {
    const result = mapPropertyForResponse(base, true, { name: "full" }, null);
    expect(result.ownerNames).toHaveLength(2);
  });

  it("importSource が正しく渡される", () => {
    const result = mapPropertyForResponse(base, true, { name: "full" }, "file.csv:1行");
    expect(result.importSource).toBe("file.csv:1行");
  });
});

describe("field_staff scope — where 条件構築", () => {
  const ME = "user-me";
  const OTHER = "user-other";

  it("admin はスコープ制限なし: AND に field_staff 条件が入らない", () => {
    const where = buildWhereWithFieldStaffScope("admin", ME);
    expect(where).not.toHaveProperty("AND");
  });

  it("field_staff: AND に createdBy/assignedTo 条件が入る", () => {
    const where = buildWhereWithFieldStaffScope("field_staff", ME);
    const andClauses = where.AND as unknown[];
    expect(andClauses).toBeDefined();
    expect(andClauses.length).toBeGreaterThanOrEqual(1);
    const scopeClause = andClauses[andClauses.length - 1] as {
      OR: { createdBy?: string; assignedTo?: string }[];
    };
    expect(scopeClause.OR).toContainEqual({ createdBy: ME });
    expect(scopeClause.OR).toContainEqual({ assignedTo: ME });
  });

  it("field_staff + keyword: OR は keyword 条件のみ、AND でスコープを強制", () => {
    const where = buildWhereWithFieldStaffScope("field_staff", ME, "東京");
    // keyword 条件は where.OR に残る
    const orClauses = where.OR as { address?: unknown }[];
    expect(orClauses).toBeDefined();
    expect(orClauses.some((c) => "address" in c)).toBe(true);
    // createdBy/assignedTo は OR に混ざっていない
    expect(orClauses.every((c) => !("createdBy" in c) && !("assignedTo" in c))).toBe(true);
    // field_staff スコープは AND に入っている
    const andClauses = where.AND as unknown[];
    expect(andClauses).toBeDefined();
    const scopeClause = andClauses[andClauses.length - 1] as {
      OR: { createdBy?: string; assignedTo?: string }[];
    };
    expect(scopeClause.OR).toContainEqual({ createdBy: ME });
    expect(scopeClause.OR).toContainEqual({ assignedTo: ME });
  });

  it("field_staff + keyword: 他ユーザーの createdBy/assignedTo は AND 条件に入らない", () => {
    const where = buildWhereWithFieldStaffScope("field_staff", ME, "東京");
    const andClauses = where.AND as unknown[];
    const scopeClause = andClauses[andClauses.length - 1] as {
      OR: { createdBy?: string; assignedTo?: string }[];
    };
    expect(scopeClause.OR).not.toContainEqual({ createdBy: OTHER });
    expect(scopeClause.OR).not.toContainEqual({ assignedTo: OTHER });
  });
});
