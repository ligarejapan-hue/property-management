import { describe, it, expect, vi } from "vitest";
import { linkExistingBuildings } from "@/lib/mansion-catalog/link-existing";
import { areaKey, buildingNameKey } from "@/lib/building-identity";

describe("linkExistingBuildings", () => {
  it("名簿に1件だけ一致する棟だけ adopt(create:false)し、つないだ数を返す", async () => {
    const adopt = vi.fn(async (id: string) => (id === "c1" ? { kind: "linked" as const, building: { id: "b1", name: "a" } } : { kind: "ambiguous" as const }));
    const n = await linkExistingBuildings({
      listUnlinked: async () => [
        { id: "b1", name: "a", address: "x", nameKey: "a", areaKey: "x" },
        { id: "b2", name: "b", address: "x", nameKey: "b", areaKey: "x" },
        { id: "b3", name: "", address: "x", nameKey: null, areaKey: "x" },
      ],
      findCatalogIds: async (_area, nameKey) => (nameKey === "a" ? ["c1"] : ["c2", "c3"]),
      adopt,
    });
    expect(n).toBe(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith("c1");
  });
});

describe("linkExistingBuildings × 古い棟", () => {
  it("★比べる形が入る前の棟(nameKey が null)は名前と住所からその場で計算して名簿を探す", async () => {
    const adopt = vi.fn(async () => ({ kind: "linked" as const, building: { id: "old", name: "プラウド青砥" } }));
    const find = vi.fn(async (...args: [string, string]) => (args.length === 2 ? ["c1"] : []));
    const n = await linkExistingBuildings({
      listUnlinked: async () => [{ id: "old", name: "プラウド青砥", address: "東京都葛飾区青戸4丁目2番14号", nameKey: null, areaKey: null }],
      findCatalogIds: find,
      adopt,
    });
    expect(n).toBe(1);
    expect(find).toHaveBeenCalledWith(areaKey("東京都葛飾区青戸4丁目2番14号"), buildingNameKey("プラウド青砥"));
  });
});
