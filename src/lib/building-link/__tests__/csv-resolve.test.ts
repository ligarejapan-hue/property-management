import { describe, it, expect } from "vitest";
import { decideCsvBuilding, resolveCsvBuilding, type CsvBuildingRow } from "@/lib/building-link/csv-resolve";

const row = (id: string, name: string, address: string, unitCount = 1): CsvBuildingRow => ({
  id, name, address, nameKey: null, areaKey: null, createdAt: new Date("2026-01-01"), unitCount,
});
const ADDR = "東京都大田区南雪谷1丁目164-2-45";

describe("decideCsvBuilding", () => {
  it("同じ町丁目・同じ比べる形があれば link", () => {
    expect(decideCsvBuilding({ buildingName: "第１ビル", address: ADDR, sameKey: [row("a", "第一ビル", "東京都大田区南雪谷1丁目164-2")], others: [] }))
      .toEqual({ kind: "link", buildingId: "a" });
  });
  it("別の町丁目の同名棟だけなら review(黙ってつながない)", () => {
    const d = decideCsvBuilding({ buildingName: "第１ビル", address: ADDR, sameKey: [], others: [row("b", "第一ビル", "東京都大田区南雪谷2丁目1")] });
    expect(d.kind).toBe("review");
  });
  it("部分一致が1件でも review", () => {
    const d = decideCsvBuilding({ buildingName: "パーク", address: ADDR, sameKey: [], others: [row("c", "パークハイツ", "東京都港区六本木1丁目1")] });
    expect(d).toMatchObject({ kind: "review", candidates: [{ id: "c" }] });
  });
  it("何も無ければ create", () => {
    expect(decideCsvBuilding({ buildingName: "新ビル", address: ADDR, sameKey: [], others: [] })).toEqual({ kind: "create" });
  });
  it("同じ町丁目の同名が2件なら、部屋数の多い方へ link(decideBuildingLink と同じ選び方)", () => {
    const d = decideCsvBuilding({
      buildingName: "第１ビル",
      address: ADDR,
      sameKey: [row("small", "第一ビル", "東京都大田区南雪谷1丁目1", 1), row("big", "第1ビル", "東京都大田区南雪谷1丁目2", 5)],
      others: [],
    });
    expect(d).toEqual({ kind: "link", buildingId: "big" });
  });
  it("review の文言は「棟名」で始まる(取込詳細の絞り込み building_unresolved が拾う)", () => {
    const d = decideCsvBuilding({ buildingName: "パーク", address: ADDR, sameKey: [], others: [row("c", "パークハイツ", "東京都港区六本木1丁目1")] });
    expect(d.kind === "review" && d.error.startsWith("棟名")).toBe(true);
  });
});

describe("resolveCsvBuilding のキャッシュ", () => {
  it("create は覚えない(次の行は前の行が作った棟を見つける)", async () => {
    const buildings: Array<CsvBuildingRow> = [];
    const db = {
      building: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          buildings
            .filter((b) => ("areaKey" in where ? b.areaKey === where.areaKey && b.nameKey === where.nameKey : true))
            .map((b) => ({ ...b, _count: { properties: b.unitCount } })),
      },
    };
    const cache = new Map();
    expect(await resolveCsvBuilding(db as never, "新ビル", ADDR, cache)).toEqual({ kind: "create" });
    buildings.push({ ...row("n1", "新ビル", "東京都大田区南雪谷1丁目164-2"), nameKey: "新ビル", areaKey: "東京都大田区南雪谷1丁目" });
    expect(await resolveCsvBuilding(db as never, "新ビル", ADDR, cache)).toEqual({ kind: "link", buildingId: "n1" });
  });
});
