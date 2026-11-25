import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { orderFieldsLikeBasicInfo } from "@/lib/property-edit-field-order";
import { salesFieldsFor } from "@/components/properties/property-edit-form";

/** 編集画面の元の並び(FORM_FIELDS の「基本」「調査」の主な欄)。 */
const BASE = [
  ["propertyType", "基本"], ["postalCode", "基本"], ["address", "基本"], ["lotNumber", "基本"], ["buildingNumber", "基本"],
  ["extraParcels", "基本"], ["buildingName", "基本"], ["roomNo", "基本"], ["realEstateNumber", "基本"],
  ["businessType", "基本"], ["registryStatus", "基本"], ["dmStatus", "基本"], ["assignedTo", "基本"],
  ["gpsLat", "基本"], ["gpsLng", "基本"], ["inquirerName", "基本"], ["note", "基本"],
  ["zoningDistrict", "調査"], ["architectureNote", "調査"],
].map(([key, section]) => ({ key, section }));

const keys = (fs: { key: string }[]) => fs.map((f) => f.key);
const bySection = (fs: { key: string; section: string }[], s: string) => keys(fs.filter((f) => f.section === s));

describe("物件の編集画面を基本情報の順に並べる(2026-11-25)", () => {
  it("区分マンション: 基本情報と同じ順(部屋の欄→管理費→入居状況→持分→棟の項目)", () => {
    const out = orderFieldsLikeBasicInfo([...BASE, ...salesFieldsFor("apartment_unit", { hasBuilding: false })], "apartment_unit");
    expect(bySection(out, "基本")).toEqual([
      "propertyType", "businessType", "postalCode", "address", "buildingName", "lotNumber", "buildingNumber",
      "extraParcels", "realEstateNumber", "roomNo", "floorNo", "exclusiveArea", "exclusiveAreaRegistry",
      "balconyArea", "layoutType", "orientation", "managementFee", "repairReserveFee", "occupancyStatus",
      "ownershipShareNote", "structureType", "aboveFloors", "basementFloors", "totalUnits", "builtYear", "builtMonth",
      "registryStatus", "dmStatus", "inquirerName", "assignedTo", "gpsLat", "gpsLng", "note",
    ]);
    // 基本情報に出ない欄は販売のまま(価格・消費税・交通・駐車場)
    expect(bySection(out, "販売")).toEqual(["salePrice", "saleTaxType", "saleTaxAmount", "access", "parking"]);
    // 区分の並び=基本→調査→販売(今までと同じ区分の順)
    expect([...new Set(out.map((f) => f.section))]).toEqual(["基本", "調査", "販売"]);
  });

  it("土地: 土地面積(計測方式)→現況が登記状況の前", () => {
    const out = orderFieldsLikeBasicInfo([...BASE, ...salesFieldsFor("land")], "land");
    const basic = bySection(out, "基本");
    expect(basic.slice(basic.indexOf("realEstateNumber"), basic.indexOf("registryStatus") + 1)).toEqual([
      "realEstateNumber", "roomNo", "landArea", "landAreaMethod", "occupancyStatus", "registryStatus",
    ]);
    expect(bySection(out, "販売")).toEqual(["salePrice", "access"]);
  });

  it("戸建: 土地面積・建物面積は基本へ・構造や築年は基本情報に出ないので販売のまま", () => {
    const out = orderFieldsLikeBasicInfo([...BASE, ...salesFieldsFor("house")], "house");
    expect(bySection(out, "基本")).toContain("totalFloorArea");
    expect(bySection(out, "販売")).toEqual([
      "salePrice", "saleTaxType", "saleTaxAmount", "access", "builtYear", "builtMonth", "structureType",
      "aboveFloors", "basementFloors", "parking",
    ]);
  });

  it("欄を足しも消しもしない", () => {
    for (const t of ["land", "house", "apartment_building", "apartment_unit"]) {
      const input = [...BASE, ...salesFieldsFor(t, { hasBuilding: false })];
      const out = orderFieldsLikeBasicInfo(input, t);
      expect(keys(out).sort()).toEqual([...new Set(keys(input))].sort());
    }
  });

  it("編集画面がこの並びを使い、棟の項目の枠も基本区分に出す", () => {
    const src = readFileSync(path.resolve(__dirname, "../../components/properties/property-edit-form.tsx"), "utf8");
    expect(src).toContain("orderFieldsLikeBasicInfo(");
    expect(src).toContain('section === "基本" && isMansion && property.building');
  });
});
