/**
 * 新しい棟を作るとき、部屋に入っている棟の項目を棟へ写す(2026-11-15 発注者決定=案3)。
 */
import { describe, it, expect } from "vitest";
import { newBuildingFactsFromUnit } from "../unit-facts";

describe("newBuildingFactsFromUnit", () => {
  it("★入っている欄だけを、棟の列の名前で返す(地上階は aboveFloors → totalFloors)", () => {
    expect(
      newBuildingFactsFromUnit({ structureType: "RC造", aboveFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3 }),
    ).toEqual({ structureType: "RC造", totalFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3 });
  });

  it("空の欄は含めない(棟の欄を null で上書きしない)", () => {
    expect(newBuildingFactsFromUnit({ structureType: " ", aboveFloors: null, totalUnits: 50 })).toEqual({ totalUnits: 50 });
    expect(newBuildingFactsFromUnit(null)).toEqual({});
  });

  it("0 も値として写す(地下階なし=0)", () => {
    expect(newBuildingFactsFromUnit({ basementFloors: 0 })).toEqual({ basementFloors: 0 });
  });
});
