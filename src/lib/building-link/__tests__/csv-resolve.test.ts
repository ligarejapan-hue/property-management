import { describe, it, expect } from "vitest";
import {
  containedNameKeys, decideCsvBuilding, resolveCsvBuilding, type CsvBuildingRow,
} from "@/lib/building-link/csv-resolve";
import { areaKey, buildingNameKey } from "@/lib/building-identity";

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

describe("resolveCsvBuilding の部分一致(両方向)", () => {
  const AREA = "東京都大田区南雪谷1丁目";
  /** prisma の where の形を写した偽物(areaKey+nameKey / nameKey: null・文字列・{in} / name: {contains})。 */
  function fakeDb(buildings: CsvBuildingRow[]) {
    const calls: Array<Record<string, unknown>> = [];
    const matches = (b: CsvBuildingRow, where: Record<string, unknown>): boolean => {
      if ("areaKey" in where) return b.areaKey === where.areaKey && b.nameKey === where.nameKey;
      if ("nameKey" in where) {
        const nk = where.nameKey as string | null | { in: string[] };
        if (nk !== null && typeof nk === "object") return b.nameKey !== null && nk.in.includes(b.nameKey);
        return b.nameKey === nk;
      }
      const name = where.name as { contains?: string } | undefined;
      if (name?.contains !== undefined) return b.name.includes(name.contains);
      throw new Error(`unexpected where ${JSON.stringify(where)}`);
    };
    return {
      calls,
      db: {
        building: {
          findMany: async ({ where }: { where: Record<string, unknown> }) => {
            calls.push(where);
            return buildings.filter((b) => matches(b, where)).map((b) => ({ ...b, _count: { properties: b.unitCount } }));
          },
        },
      },
    };
  }
  const keyed = (id: string, name: string, address: string): CsvBuildingRow => ({
    ...row(id, name, address), nameKey: buildingNameKey(name), areaKey: areaKey(address),
  });

  it("既存の棟名が取込の名前を含む(前方向)→ review に候補として出る", async () => {
    const { db } = fakeDb([keyed("e1", "パークハイツ本館", `${AREA}1`)]);
    const r = await resolveCsvBuilding(db as never, "パークハイツ", ADDR, new Map());
    expect(r).toMatchObject({ kind: "review", candidates: [{ id: "e1", name: "パークハイツ本館" }] });
  });

  it("取込の名前が既存の棟名を含む(逆方向)→ 作らずに review(候補に既存の棟)", async () => {
    const { db } = fakeDb([keyed("e1", "パークハイツ", `${AREA}1`)]);
    const r = await resolveCsvBuilding(db as never, "パークハイツ本館", ADDR, new Map());
    expect(r).toMatchObject({ kind: "review", candidates: [{ id: "e1", name: "パークハイツ" }] });
  });

  it("逆方向は比べる形で見る(既存「第一パーク」・取込「第１パーク南棟」)", async () => {
    const { db } = fakeDb([keyed("e1", "第一パーク", "東京都港区六本木1丁目1")]);
    const r = await resolveCsvBuilding(db as never, "第１パーク南棟", ADDR, new Map());
    expect(r).toMatchObject({ kind: "review", candidates: [{ id: "e1" }] });
  });

  it("逆方向は key が null の古い棟も見る", async () => {
    const { db } = fakeDb([row("old", "パークハイツ", `${AREA}1`)]);
    const r = await resolveCsvBuilding(db as never, "パークハイツ本館", ADDR, new Map());
    expect(r).toMatchObject({ kind: "review", candidates: [{ id: "old" }] });
  });

  it("短すぎる既存の棟名(2文字)は、それを含むだけの別の名前を横取りしない", async () => {
    const { db } = fakeDb([keyed("s1", "ハイ", `${AREA}1`), row("s2", "コー", `${AREA}2`)]);
    expect(await resolveCsvBuilding(db as never, "ハイツコーポ南雪谷", ADDR, new Map())).toEqual({ kind: "create" });
  });

  it("containedNameKeys は3文字以上・全体以外の部分だけ", () => {
    expect(containedNameKeys("ABCD").sort()).toEqual(["ABC", "BCD"]);
    expect(containedNameKeys("ABC")).toEqual([]);
  });

  it("似た棟が何も無ければ create のまま・create は覚えない", async () => {
    const buildings: CsvBuildingRow[] = [];
    const { db } = fakeDb(buildings);
    const cache = new Map();
    expect(await resolveCsvBuilding(db as never, "パークハイツ本館", ADDR, cache)).toEqual({ kind: "create" });
    expect(cache.size).toBe(0);
  });

  it("同じ町丁目・同じ比べる形があれば、逆方向の候補があっても link", async () => {
    const { db } = fakeDb([keyed("same", "パークハイツ本館", `${AREA}9`), keyed("short", "パークハイツ", `${AREA}1`)]);
    expect(await resolveCsvBuilding(db as never, "パークハイツ本館", ADDR, new Map())).toEqual({ kind: "link", buildingId: "same" });
  });
});
