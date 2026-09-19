import { describe, it, expect } from "vitest";
import { salesFieldsFor } from "../property-edit-form";

describe("salesFieldsFor — 種別ごとに出す欄", () => {
  it("土地", () => {
    expect(salesFieldsFor("land").map((f) => f.key)).toEqual([
      "salePrice", "access", "landArea", "landAreaMethod",
    ]);
  });
  it("戸建", () => {
    expect(salesFieldsFor("house").map((f) => f.key)).toContain("totalFloorArea");
    expect(salesFieldsFor("house").map((f) => f.key)).toContain("builtYear");
    expect(salesFieldsFor("house").map((f) => f.key)).not.toContain("grossYield");
  });
  it("一棟は収益の欄も出す", () => {
    const keys = salesFieldsFor("apartment_building").map((f) => f.key);
    expect(keys).toContain("grossYield");
    expect(keys).toContain("expectedIncome");
    expect(keys).toContain("totalUnits");
  });
  it("区分は部屋の欄を出し、棟の欄は出さない", () => {
    const keys = salesFieldsFor("apartment_unit").map((f) => f.key);
    expect(keys).toContain("exclusiveArea");
    expect(keys).toContain("managementFee");
    expect(keys).not.toContain("structureType");
    expect(keys).not.toContain("totalUnits");
  });
});
