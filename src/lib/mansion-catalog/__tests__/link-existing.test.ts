import { describe, it, expect, vi } from "vitest";
import { linkExistingBuildings } from "@/lib/mansion-catalog/link-existing";

describe("linkExistingBuildings", () => {
  it("名簿に1件だけ一致する棟だけ adopt(create:false)し、つないだ数を返す", async () => {
    const adopt = vi.fn(async (id: string) => (id === "c1" ? { kind: "linked" as const, building: { id: "b1", name: "a" } } : { kind: "ambiguous" as const }));
    const n = await linkExistingBuildings({
      listUnlinked: async () => [
        { id: "b1", nameKey: "a", areaKey: "x" },
        { id: "b2", nameKey: "b", areaKey: "x" },
        { id: "b3", nameKey: null, areaKey: "x" },
      ],
      findCatalogIds: async (_area, nameKey) => (nameKey === "a" ? ["c1"] : ["c2", "c3"]),
      adopt,
    });
    expect(n).toBe(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith("c1");
  });
});
