import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { landBuildingAreaRows } from "../property-area-display";

// 従業員の指摘⑧(2026-10-25)「戸建と土地の基本情報に土地面積や建物面積の表示がない」。
describe("基本情報の土地面積・建物面積", () => {
  const base = { landArea: "120.5", landAreaMethod: "公簿", totalFloorArea: 98.12 };

  it("★戸建は土地面積(計測方式つき)と建物面積を出す", () => {
    expect(landBuildingAreaRows({ ...base, propertyType: "house" })).toEqual([
      { label: "土地面積", value: "120.50m²（公簿）" },
      { label: "建物面積（延べ）", value: "98.12m²" },
    ]);
  });

  it("★土地は土地面積だけ", () => {
    expect(landBuildingAreaRows({ ...base, propertyType: "land" })).toEqual([
      { label: "土地面積", value: "120.50m²（公簿）" },
    ]);
  });

  it("★未入力でも戸建・土地では行を出す(空=「—」)。計測方式だけ入っていても面積が無ければ空", () => {
    expect(
      landBuildingAreaRows({ propertyType: "house", landArea: null, landAreaMethod: "実測", totalFloorArea: null }),
    ).toEqual([
      { label: "土地面積", value: null },
      { label: "建物面積（延べ）", value: null },
    ]);
  });

  it("一棟マンション・一棟アパートも両方出す", () => {
    for (const t of ["apartment_building", "apartment_block"]) {
      expect(landBuildingAreaRows({ ...base, propertyType: t }).map((r) => r.label)).toEqual([
        "土地面積",
        "建物面積（延べ）",
      ]);
    }
  });

  it("区分マンションは出さない(専有面積を別に出している)", () => {
    expect(landBuildingAreaRows({ ...base, propertyType: "apartment_unit" })).toEqual([]);
    expect(landBuildingAreaRows({ ...base, propertyType: "unit" })).toEqual([]);
  });

  it("種別が不明なら、入っている値だけ出す", () => {
    expect(landBuildingAreaRows({ ...base, propertyType: "unknown", totalFloorArea: null })).toEqual([
      { label: "土地面積", value: "120.50m²（公簿）" },
    ]);
    expect(
      landBuildingAreaRows({ propertyType: "unknown", landArea: null, landAreaMethod: null, totalFloorArea: null }),
    ).toEqual([]);
  });

  it("★物件の詳細の基本情報がこの行を出している", () => {
    const page = readFileSync(
      join(__dirname, "..", "..", "app", "(dashboard)", "properties", "[id]", "page.tsx"),
      "utf8",
    );
    expect(page).toContain("landBuildingAreaRows(");
  });
});
