import { describe, it, expect } from "vitest";
import { loadCatalogLines, LOAD_BATCH, type CatalogStore } from "@/lib/mansion-catalog/load";
import type { CatalogRow } from "@/lib/mansion-catalog/parse";

const line = (id: string, name = `棟${id}`) =>
  JSON.stringify({ pref: "13", page: 1, fetchedAt: "2026-10-17T00:00:00Z", id, name, address: "東京都葛飾区青戸4丁目2番14号", stations: [], completed: "2000年1月", structure: "RC", floors: "地上5階建", units: "20戸", developer: null, manager: null });

function fakeStore() {
  const rows = new Map<string, CatalogRow>();
  const batches: number[] = [];
  const store: CatalogStore = {
    async upsertMany(batch) {
      batches.push(batch.length);
      let inserted = 0;
      for (const r of batch) {
        if (!rows.has(r.sourceId)) inserted++;
        rows.set(r.sourceId, r);
      }
      return { inserted, updated: batch.length - inserted };
    },
  };
  return { store, rows, batches };
}

describe("loadCatalogLines", () => {
  it("500件ずつ入れ、入れた/更新した数を返す", async () => {
    const f = fakeStore();
    const lines = Array.from({ length: LOAD_BATCH + 3 }, (_, i) => line(String(i + 1)));
    const r = await loadCatalogLines(lines, f.store);
    expect(r).toEqual({ inserted: LOAD_BATCH + 3, updated: 0, skipped: 0, duplicates: 0 });
    expect(f.batches).toEqual([LOAD_BATCH, 3]);
  });
  it("★壊れた行は飛ばして数え、同じ番号は後の行で1件にまとめる", async () => {
    const f = fakeStore();
    const r = await loadCatalogLines(["{", "", line("1", "古い名前"), line("2"), line("1", "新しい名前")], f.store);
    expect(r).toEqual({ inserted: 2, updated: 0, skipped: 2, duplicates: 1 });
    expect(f.rows.get("1")?.name).toBe("新しい名前");
  });
  it("2回目は更新として数える", async () => {
    const f = fakeStore();
    await loadCatalogLines([line("1")], f.store);
    expect(await loadCatalogLines([line("1")], f.store)).toEqual({ inserted: 0, updated: 1, skipped: 0, duplicates: 0 });
  });
});
