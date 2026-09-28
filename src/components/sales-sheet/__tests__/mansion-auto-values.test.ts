/**
 * 区分マンションの作成画面の既定値(computeMansionAutoValues)。
 * 構造・地上階・総戸数(表示だけの欄)と、地下階・築年月(前回保存した値のヒント)は、
 * 棟に紐づいていれば棟の値・紐づいていなければ物件の欄から出す(unit-building-facts.ts)。
 * 本番の区分は全件が棟に紐づいていない(2026-09-27 実測)。
 */
import { describe, it, expect } from "vitest";
import { computeMansionAutoValues } from "../SalesSheetCreateButton";

const unitFacts = {
  structureType: "RC",
  aboveFloors: 11,
  basementFloors: 1,
  totalUnits: 48,
  builtYear: 2008,
  builtMonth: 3,
};

describe("computeMansionAutoValues — 棟の項目", () => {
  it("棟が無ければ、構造・地上階・総戸数と地下階・築年月のヒントを物件の欄から出す", () => {
    const r = computeMansionAutoValues({ ...unitFacts, building: null });
    expect(r.preview).toMatchObject({ structure: "RC", totalFloors: "11", totalUnits: "48" });
    expect(r.hints.builtYearMonth).toContain("2008年3月");
    expect(r.hints.basementFloors).toContain("1階");
  });

  it("棟があれば、物件の欄に値があっても棟の値を出す", () => {
    const r = computeMansionAutoValues({
      ...unitFacts,
      building: { structureType: "SRC", totalFloors: 7, totalUnits: 20, basementFloors: 0, builtYear: 1972 },
    });
    expect(r.preview).toMatchObject({ structure: "SRC", totalFloors: "7", totalUnits: "20" });
    expect(r.hints.builtYearMonth).toContain("1972年");
    expect(r.hints.basementFloors).toContain("0階");
  });
});
