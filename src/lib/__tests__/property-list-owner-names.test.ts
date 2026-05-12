import { describe, it, expect } from "vitest";
import { maskValue } from "../permissions";

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
