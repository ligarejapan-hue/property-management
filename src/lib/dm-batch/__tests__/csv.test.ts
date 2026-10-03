import { describe, it, expect } from "vitest";
import { buildBatchCsv, sha256Hex, type BatchCsvSource } from "../csv";
import { sortUniqueIds } from "../locks";
import type { OwnerDisplayConfig } from "@/lib/api-helpers";

const PLAIN: OwnerDisplayConfig = {
  name: "full",
  nameKana: "full",
  phone: "full",
  zip: "full",
  address: "full",
  note: "full",
  email: "full",
  corporateNumber: "full",
} as OwnerDisplayConfig;

function source(over: Partial<BatchCsvSource> = {}): BatchCsvSource {
  return {
    items: [{ id: "i1", propertyId: "p1", ownerId: "o1", groupOwnerIds: ["o1", "o2"] }],
    properties: new Map([
      [
        "p1",
        {
          id: "p1",
          dmStatus: "send",
          isArchived: false,
          createdBy: "u1",
          assignedTo: null,
          address: "東京都C区1-1",
          propertyType: "land",
          propertyOwners: [
            {
              isPrimary: true,
              relationship: null,
              owner: { id: "o1", name: "甲 太郎", nameKana: null, zip: "100-0001", address: "東京都A", currentZip: null, currentAddress: null, corporateNumber: null },
            },
            {
              isPrimary: false,
              relationship: "子",
              owner: { id: "o2", name: "甲 次郎", nameKana: null, zip: "100-0001", address: "東京都A", currentZip: null, currentAddress: null, corporateNumber: null },
            },
          ],
        },
      ],
    ]),
    importSourceMap: new Map([["p1", "MGMT-1"]]),
    ownerDisplayConfig: PLAIN,
    ...over,
  };
}

describe("buildBatchCsv / sha256Hex", () => {
  it("BOM で始まり、代表の氏名と共有者数が入る", () => {
    const csv = buildBatchCsv(source());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("甲 太郎");
    expect(csv).toContain("MGMT-1");
    expect(csv).toContain("2"); // 共有者数
  });

  it("数式インジェクションを無害化する", () => {
    const s = source();
    s.properties.get("p1")!.propertyOwners[0].owner.name = "=SUM(A1)";
    const csv = buildBatchCsv(s);
    expect(csv).not.toMatch(/(^|,)"?=SUM/m);
  });

  it("同一入力→同一digest・1文字違い→別digest", () => {
    const a = sha256Hex(buildBatchCsv(source()));
    const b = sha256Hex(buildBatchCsv(source()));
    expect(a).toBe(b);
    const s = source();
    s.properties.get("p1")!.propertyOwners[0].owner.address = "東京都A2";
    const c = sha256Hex(buildBatchCsv(s));
    expect(c).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("保存グループに居ない現在の所有者は行に載せない", () => {
    const s = source();
    s.items[0].groupOwnerIds = ["o1"]; // o2 は保存集合外
    const csv = buildBatchCsv(s);
    expect(csv).not.toContain("甲 次郎");
  });
});

describe("配信停止URLの列", () => {
  it("見出しの末尾が「配信停止URL」で、既存の見出しの並びは変わらない", async () => {
    const { DM_EXPORT_HEADERS } = await import("@/lib/dm-export");
    expect(DM_EXPORT_HEADERS[DM_EXPORT_HEADERS.length - 1]).toBe("配信停止URL");
    expect(DM_EXPORT_HEADERS.slice(0, 13)).toEqual([
      "管理ID", "物件住所", "所有者名", "敬称", "郵便番号", "所有者住所", "物件種別",
      "所有者名カナ", "代表者", "続柄", "DM判断", "送付先所有者名一覧", "共有者数",
    ]);
  });

  it("unsubscribeUrlFor を渡すと行ごとのURL、渡さなければ空", () => {
    const withUrl = buildBatchCsv(source({ unsubscribeUrlFor: (id) => `https://x.example/u/${id}` }));
    const rows = withUrl.trim().split("\r\n");
    expect(rows[0].endsWith("配信停止URL")).toBe(true);
    expect(rows[1].endsWith(",https://x.example/u/i1")).toBe(true);
    const without = buildBatchCsv(source());
    expect(without.trim().split("\r\n")[1].endsWith(",")).toBe(true);
  });
});

describe("sortUniqueIds", () => {
  it("重複排除+昇順", () => {
    expect(sortUniqueIds(["b", "a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(sortUniqueIds([])).toEqual([]);
  });
});
