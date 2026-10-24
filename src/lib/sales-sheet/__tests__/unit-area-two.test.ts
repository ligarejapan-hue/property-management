import { describe, expect, it } from "vitest";
import { buildWriteback, labelsOf } from "../property-writeback/build-writeback";
import { buildSaleMansionDocument } from "../build-document";

// 区分マンションの専有面積は2つ(2026-10-24): exclusiveArea=壁芯(パンフレット) / exclusiveAreaRegistry=登記簿。
describe("販売図面の専有面積の書き戻し(壁芯/内法)", () => {
  it("★面積計測方式が「内法」なら登記簿の欄へ入れる", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { exclusiveArea: "63.5", areaMethod: "内法" },
      current: { property: {}, building: null },
    });
    expect(r.property).toEqual({ exclusiveAreaRegistry: 63.5 });
    expect(labelsOf("mansion", r)).toContain("専有面積");
  });

  it("★壁芯・未選択なら今までどおり壁芯の欄(exclusiveArea)", () => {
    for (const areaMethod of ["壁芯", undefined]) {
      const r = buildWriteback({
        kind: "mansion",
        values: { exclusiveArea: "67.21", areaMethod },
        current: { property: {}, building: null },
      });
      expect(r.property).toEqual({ exclusiveArea: 67.21 });
    }
  });

  it("内法で登記簿の欄と同じ値なら書かない", () => {
    const r = buildWriteback({
      kind: "mansion",
      values: { exclusiveArea: "63.5", areaMethod: "内法" },
      current: { property: { exclusiveAreaRegistry: "63.5" }, building: null },
    });
    expect(r.property).toEqual({});
  });
});

describe("販売図面の専有面積の自動反映(壁芯/内法)", () => {
  const areaRow = (overrides: Record<string, string>): string | undefined => {
    const doc = buildSaleMansionDocument({
      property: { address: "東京都杉並区西荻北1-4-3", exclusiveArea: "67.21", exclusiveAreaRegistry: "63.5" },
      building: { name: "西荻リリエンハイム", totalFloors: 7, builtYear: 1972, structureType: "RC" },
      photos: [],
      overrides,
    });
    for (const el of doc.elements as { type: string; rows?: { label: string; value: string }[] }[]) {
      const r = el.type === "table" ? el.rows?.find((row) => row.label === "専有面積") : undefined;
      if (r) return r.value;
    }
    return undefined;
  };

  it("★内法を選ぶと登記簿の面積が入る", () => {
    expect(areaRow({ areaMethod: "内法" })).toBe("63.5㎡（内法）");
  });

  it("★壁芯・未選択なら壁芯の面積が入る", () => {
    expect(areaRow({ areaMethod: "壁芯" })).toBe("67.21㎡（壁芯）");
    expect(areaRow({})).toBe("67.21㎡");
  });

  it("手で入れた面積があればそれを使う(今までどおり)", () => {
    expect(areaRow({ areaMethod: "内法", exclusiveArea: "60" })).toBe("60㎡（内法）");
  });
});
