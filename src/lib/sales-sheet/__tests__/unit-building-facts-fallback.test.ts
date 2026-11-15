/**
 * 区分マンションの棟の項目をどこから読むか(2026-11-15 発注者決定=案3)。
 * 棟の値が正。棟の欄が空のときだけ、その欄は物件そのものの欄から読む。
 */
import { describe, it, expect } from "vitest";
import { unitBuildingFacts } from "../unit-building-facts";

const unit = { structureType: "RC造", aboveFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3 };
const emptyBuilding = { structureType: null, totalFloors: null, basementFloors: null, totalUnits: null, builtYear: null, builtMonth: null };

describe("unitBuildingFacts", () => {
  it("棟が無ければ物件の欄から(今までどおり)", () => {
    expect(unitBuildingFacts(unit, null)).toEqual({
      structureType: "RC造", totalFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3,
    });
  });

  it("★棟の欄が全部空なら、物件の欄の値を使う(物件名と一緒に入れた値が見えなくならない)", () => {
    expect(unitBuildingFacts(unit, emptyBuilding)).toEqual({
      structureType: "RC造", totalFloors: 10, basementFloors: 1, totalUnits: 50, builtYear: 2001, builtMonth: 3,
    });
  });

  it("★棟に値が入っていれば、物件の欄に何が入っていても棟の値(棟の値が正)", () => {
    const building = { structureType: "SRC造", totalFloors: 14, basementFloors: 2, totalUnits: 80, builtYear: 1995, builtMonth: 11 };
    expect(unitBuildingFacts(unit, building)).toEqual({
      structureType: "SRC造", totalFloors: 14, basementFloors: 2, totalUnits: 80, builtYear: 1995, builtMonth: 11,
    });
  });

  it("★欄ごとに決める(棟に階数だけあれば階数は棟・ほかは物件)", () => {
    expect(unitBuildingFacts(unit, { ...emptyBuilding, totalFloors: 14 })).toMatchObject({
      totalFloors: 14, structureType: "RC造", totalUnits: 50,
    });
  });

  it("★築年月は年と月をひと組で扱う(棟の年に、物件の月を継ぎ足さない)", () => {
    expect(unitBuildingFacts(unit, { ...emptyBuilding, builtYear: 1995 })).toMatchObject({ builtYear: 1995, builtMonth: null });
  });

  it("棟に築月だけ入っているときは、今までどおり棟の月だけ", () => {
    expect(unitBuildingFacts(unit, { ...emptyBuilding, builtMonth: 7 })).toMatchObject({ builtYear: null, builtMonth: 7 });
  });

  it("棟の構造が空白だけなら空として扱う", () => {
    expect(unitBuildingFacts(unit, { ...emptyBuilding, structureType: "  " }).structureType).toBe("RC造");
  });

  it("棟も物件も空なら null", () => {
    expect(unitBuildingFacts({}, emptyBuilding)).toEqual({
      structureType: null, totalFloors: null, basementFloors: null, totalUnits: null, builtYear: null, builtMonth: null,
    });
  });
});
