import { describe, it, expect } from "vitest";
import { propertyFillFromInvestigation } from "../property-fill";

const empty = { zoningDistrict: null, buildingCoverageRatio: null, floorAreaRatio: null };

describe("propertyFillFromInvestigation(取得した用途地域・建蔽率・容積率を物件の欄へ・空欄のときだけ)", () => {
  it("物件の欄が空なら、取れた値を写す", () => {
    expect(
      propertyFillFromInvestigation(empty, {
        zoningDistrict: "第一種住居地域",
        buildingCoverageRatio: 60,
        floorAreaRatio: 200,
      }),
    ).toEqual({ zoningDistrict: "第一種住居地域", buildingCoverageRatio: 60, floorAreaRatio: 200 });
  });

  it("人が入れた値は上書きしない(欄ごとに見る)", () => {
    expect(
      propertyFillFromInvestigation(
        { zoningDistrict: "商業地域", buildingCoverageRatio: null, floorAreaRatio: 400 },
        { zoningDistrict: "第一種住居地域", buildingCoverageRatio: 60, floorAreaRatio: 200 },
      ),
    ).toEqual({ buildingCoverageRatio: 60 });
  });

  it("取れなかった項目は写さない(空のまま)", () => {
    expect(
      propertyFillFromInvestigation(empty, { zoningDistrict: "準工業地域", buildingCoverageRatio: null, floorAreaRatio: null }),
    ).toEqual({ zoningDistrict: "準工業地域" });
  });

  it("空白だけの用途地域は空欄とみなし、空白だけの取得値は写さない", () => {
    expect(
      propertyFillFromInvestigation(
        { zoningDistrict: "  ", buildingCoverageRatio: null, floorAreaRatio: null },
        { zoningDistrict: "近隣商業地域", buildingCoverageRatio: null, floorAreaRatio: null },
      ),
    ).toEqual({ zoningDistrict: "近隣商業地域" });
    expect(propertyFillFromInvestigation(empty, { zoningDistrict: " ", buildingCoverageRatio: null, floorAreaRatio: null })).toBeNull();
  });

  it("写すものが無ければ null(物件の行に書き込まない=版を上げない)", () => {
    expect(propertyFillFromInvestigation(empty, empty)).toBeNull();
    expect(
      propertyFillFromInvestigation(
        { zoningDistrict: "商業地域", buildingCoverageRatio: 80, floorAreaRatio: 400 },
        { zoningDistrict: "第一種住居地域", buildingCoverageRatio: 60, floorAreaRatio: 200 },
      ),
    ).toBeNull();
  });

  it("Decimal のような値(toString を持つ物)も数として扱う", () => {
    const dec = (n: number) => ({ toString: () => String(n), toNumber: () => n });
    expect(
      propertyFillFromInvestigation(
        { zoningDistrict: null, buildingCoverageRatio: dec(50), floorAreaRatio: null },
        { zoningDistrict: null, buildingCoverageRatio: dec(60), floorAreaRatio: dec(150) },
      ),
    ).toEqual({ floorAreaRatio: 150 });
  });
});
