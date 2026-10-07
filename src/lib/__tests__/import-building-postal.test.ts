import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyBuildingPostalCodeInTx } from "@/lib/import-building-postal";
import { buildingPostalCodeFromRow, rowFieldMapExtra } from "@/lib/import-row-field-map";

// 要確認の行を確定したとき、行の棟郵便番号を、つないだ棟へ入れる(@codex P2)。
// CSV 取込は要確認の行では棟郵便番号を入れずに残すため、確定側で入れないと消えてしまう。

function fakeTx(prev: string | null | undefined) {
  const update = vi.fn().mockResolvedValue({});
  const createMany = vi.fn().mockResolvedValue({});
  const tx = {
    building: {
      findUnique: vi.fn().mockResolvedValue(prev === undefined ? null : { postalCode: prev }),
      update,
    },
    changeLog: { createMany },
  };
  return { tx, update, createMany };
}

describe("buildingPostalCodeFromRow", () => {
  it("棟郵便番号の見出しを読み、7桁をハイフンなしにする", () =>
    expect(buildingPostalCodeFromRow({ "棟郵便番号": "145-0066" })).toBe("1450066"));
  it("英字の見出しも読む", () =>
    expect(buildingPostalCodeFromRow({ "building_postal_code": "1450066" })).toBe("1450066"));
  it("不正な値・無いときは null", () => {
    expect(buildingPostalCodeFromRow({ "棟郵便番号": "12345" })).toBeNull();
    expect(buildingPostalCodeFromRow({ "郵便番号": "1450066" })).toBeNull();
  });
  it("取込で使った表が行にあれば、その表で読む", () => {
    const m = { "建物〒": "buildingPostalCode" };
    expect(buildingPostalCodeFromRow({ "建物〒": "1450066", ...rowFieldMapExtra(m, Object.keys(m)) })).toBe("1450066");
  });
});

describe("applyBuildingPostalCodeInTx", () => {
  it("今の値と違えば書き、棟の変更履歴を残す", async () => {
    const { tx, update, createMany } = fakeTx(null);
    await applyBuildingPostalCodeInTx(tx as never, "b1", "1450066", "u1");
    expect(update).toHaveBeenCalledWith({ where: { id: "b1" }, data: { postalCode: "1450066" } });
    expect(createMany).toHaveBeenCalledTimes(1);
    const entries = createMany.mock.calls[0][0].data;
    expect(entries[0]).toMatchObject({ targetTable: "buildings", targetId: "b1", source: "csv_import" });
  });
  it("同じ値なら何も書かない", async () => {
    const { tx, update, createMany } = fakeTx("1450066");
    await applyBuildingPostalCodeInTx(tx as never, "b1", "1450066", "u1");
    expect(update).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
  it("棟が無ければ何もしない", async () => {
    const { tx, update } = fakeTx(undefined);
    await applyBuildingPostalCodeInTx(tx as never, "b1", "1450066", "u1");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("確定・再試行の配線", () => {
  for (const [rel, v] of [
    ["src/app/api/import/jobs/[jobId]/rows/[rowId]/route.ts", "sourceData"],
    ["src/app/api/import/jobs/[jobId]/rows/[rowId]/retry/route.ts", "mergedData"],
  ] as const) {
    it(`${rel}: つないだ棟へ、同じトランザクションで入れる`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      const linkAt = src.indexOf("await applyBuildingLink(tx, {");
      const postalAt = src.indexOf(`buildingPostalCodeFromRow(${v})`);
      const applyAt = src.indexOf("await applyBuildingPostalCodeInTx(tx, buildingLink.building.id, buildingPostalCode, session.id);");
      const returnAt = src.indexOf("return { property, buildingLink };");
      expect(linkAt).toBeGreaterThan(0);
      expect(postalAt).toBeGreaterThan(linkAt);
      expect(applyAt).toBeGreaterThan(postalAt);
      expect(returnAt).toBeGreaterThan(applyAt);
    });
  }
});
