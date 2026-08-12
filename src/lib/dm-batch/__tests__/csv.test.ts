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

describe("sortUniqueIds", () => {
  it("重複排除+昇順", () => {
    expect(sortUniqueIds(["b", "a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(sortUniqueIds([])).toEqual([]);
  });
});
