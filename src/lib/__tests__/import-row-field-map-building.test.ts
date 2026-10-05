import { describe, it, expect } from "vitest";
import { buildPropertyCreateData, buildingChoiceFromRow } from "@/lib/import-row-field-map";

describe("取込行の確定で棟を落とさない", () => {
  it("マンション名の列を物件名にし、区分マンションで作る", () => {
    const d = buildPropertyCreateData({ "住所": "東京都大田区南雪谷1丁目1", "マンション名": "パーク第一" }, "u");
    expect(d).toMatchObject({ propertyType: "apartment_unit", buildingName: "パーク第一" });
  });
  it("選んだ棟は existing(小文字)", () => {
    expect(buildingChoiceFromRow({ __resolved_building_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }))
      .toEqual({ kind: "existing", buildingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });
  it("無い・形が違うなら auto", () => {
    expect(buildingChoiceFromRow({})).toEqual({ kind: "auto" });
    expect(buildingChoiceFromRow({ __resolved_building_id: "x" })).toEqual({ kind: "auto" });
  });
});
