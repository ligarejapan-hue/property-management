import { describe, it, expect } from "vitest";
import { buildingNameKey } from "@/lib/building-identity";
import { rankBuildingSuggestions, readAllLegacyBuildings, LEGACY_PAGE_SIZE, LEGACY_MAX_ROWS } from "@/lib/building-link/suggest";

const r = (id: string, name: string, address: string, unitCount = 1) => ({
  id, name, address, nameKey: null, areaKey: null, unitCount, createdAt: new Date("2026-01-01"),
});
const target = { nameKey: buildingNameKey("パーク第１")!, areaKey: "東京都大田区南雪谷1丁目" };

describe("rankBuildingSuggestions", () => {
  it("同じ名前・同じ丁目 → 同じ名前・別の丁目 → 部分一致 の順", () => {
    const out = rankBuildingSuggestions([
      r("p", "パーク第一ハイツ", "東京都港区六本木1丁目1"),
      r("o", "パーク第一", "東京都大田区南雪谷2丁目1"),
      r("s", "パーク第１", "東京都大田区南雪谷1丁目164-2"),
    ], target);
    expect(out.map((x) => x.id)).toEqual(["s", "o", "p"]);
    expect(out[0]).toMatchObject({ sameName: true, sameArea: true });
    expect(out[1]).toMatchObject({ sameName: true, sameArea: false });
  });
  it("住所は町丁目までに丸める(番地を出さない)", () => {
    const [s] = rankBuildingSuggestions([r("s", "パーク第１", "東京都大田区南雪谷1丁目164-2")], target);
    expect(s.area).toBe("東京都大田区南雪谷1丁目");
    expect(JSON.stringify(s)).not.toContain("164");
  });
  it("最大10件", () => {
    const rows = Array.from({ length: 15 }, (_, i) => r(`x${i}`, `パーク第一${i}`, "東京都港区六本木1丁目1"));
    expect(rankBuildingSuggestions(rows, target)).toHaveLength(10);
  });
  it("同じ順位なら戸数が多い順、同数なら古い順", () => {
    const mk = (id: string, units: number, created: string) => ({
      ...r(id, "パーク第一ハイツ", "東京都港区六本木1丁目1", units), createdAt: new Date(created),
    });
    const out = rankBuildingSuggestions([
      mk("new2", 2, "2026-03-01"),
      mk("many", 5, "2026-04-01"),
      mk("old2", 2, "2026-01-01"),
    ], target);
    expect(out.map((x) => x.id)).toEqual(["many", "old2", "new2"]);
  });
});

describe("readAllLegacyBuildings(古い棟を全部読む・@codex R5)", () => {
  // findMany の代わり: id 昇順・cursor の次から take 件を返す(cursor 自身は含めない)。
  const fakeDb = (n: number) => {
    const rows = Array.from({ length: n }, (_, i) => ({ id: `id${String(i).padStart(5, "0")}`, name: i === 429 ? "パーク第一" : `無関係${i}` }));
    const calls: { cursorId: string | null; take: number }[] = [];
    const fetchPage = async (a: { cursorId: string | null; take: number }) => {
      calls.push(a);
      const start = a.cursorId === null ? 0 : rows.findIndex((r) => r.id === a.cursorId) + 1;
      return rows.slice(start, start + a.take);
    };
    return { fetchPage, calls };
  };

  it("★450件のうち430件目にある同じ名前の棟も読み、complete=true", async () => {
    const { fetchPage, calls } = fakeDb(450);
    const res = await readAllLegacyBuildings(fetchPage);
    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(450);
    expect(res.rows.some((r) => r.name === "パーク第一")).toBe(true);
    expect(calls.map((c) => c.take)).toEqual([LEGACY_PAGE_SIZE, LEGACY_PAGE_SIZE, LEGACY_PAGE_SIZE]);
    expect(calls[0].cursorId).toBeNull();
    expect(calls[1].cursorId).toBe("id00199");
  });

  it("★2000件を超えると上限で止め、complete=false", async () => {
    const { fetchPage } = fakeDb(2500);
    const res = await readAllLegacyBuildings(fetchPage);
    expect(res.complete).toBe(false);
    expect(res.rows).toHaveLength(LEGACY_MAX_ROWS);
  });

  it("ちょうど上限の件数で尽きたら complete=true(続きが無いことを確かめる)", async () => {
    const { fetchPage } = fakeDb(2000);
    const res = await readAllLegacyBuildings(fetchPage);
    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(2000);
  });

  it("0件なら complete=true", async () => {
    const { fetchPage } = fakeDb(0);
    expect(await readAllLegacyBuildings(fetchPage)).toEqual({ rows: [], complete: true });
  });
});
