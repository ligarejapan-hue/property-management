import { describe, it, expect } from "vitest";
import { MAIN_ROW_SPECS, splitMainDetailRows, splitDetailColumns, type SheetKind } from "../main-detail-rows";
import { MANSION_FIELDS, LAND_FIELDS, HOUSE_FIELDS, BUILDING_FIELDS } from "../field-model";

const FIELDS: Record<SheetKind, typeof HOUSE_FIELDS> = {
  mansion: MANSION_FIELDS, land: LAND_FIELDS, house: HOUSE_FIELDS, building: BUILDING_FIELDS,
};

describe("MAIN_ROW_SPECS", () => {
  it.each(["mansion", "land", "house", "building"] as const)("%s: 8行・参照キーはすべて field-model に存在", (kind) => {
    expect(MAIN_ROW_SPECS[kind]).toHaveLength(8);
    const keys = new Set(FIELDS[kind].map((f) => f.key));
    for (const spec of MAIN_ROW_SPECS[kind]) for (const part of spec.parts) expect(keys.has(part.key)).toBe(true);
  });
});

describe("splitMainDetailRows", () => {
  it("戸建: 主要8行の順番・まとめ行の連結", () => {
    const { main } = splitMainDetailRows("house", HOUSE_FIELDS, {
      access: "西武池袋線「富士見台」駅 徒歩6分", layout: "4LDK", landArea: "100.12㎡（公簿）",
      buildingArea: "98.54", builtYearMonth: "2008年3月", structure: "木造", aboveFloors: "2",
      parking: "有", occupancy: "居住中", delivery: "相談",
    });
    expect(main.map((r) => r.label)).toEqual(["交通", "間取り", "土地面積", "建物面積", "築年月", "構造・階数", "駐車場", "現況・引渡"]);
    expect(main.find((r) => r.label === "建物面積")?.value).toBe("98.54㎡");
    expect(main.find((r) => r.label === "構造・階数")?.value).toBe("木造 / 地上2階");
    expect(main.find((r) => r.label === "現況・引渡")?.value).toBe("居住中 / 引渡 相談");
  });
  it("主要表は値が空でも8行とも残す", () => {
    const { main } = splitMainDetailRows("mansion", MANSION_FIELDS, {});
    expect(main).toHaveLength(8);
    expect(main.every((r) => r.value === "")).toBe(true);
  });
  it("区分: 管理費・修繕積立金と所在階・階数", () => {
    const { main } = splitMainDetailRows("mansion", MANSION_FIELDS, { managementFee: "12800", repairFee: "15600", floorNo: "5", totalFloors: "11" });
    expect(main.find((r) => r.label === "管理費・修繕積立金")?.value).toBe("管理費 12800円/月 / 修繕 15600円/月");
    expect(main.find((r) => r.label === "所在階・階数")?.value).toBe("5階 / 地上11階");
  });
  it("詳細: 主要・価格・物件種目・建物名称・会社の項目を出さず、空行を出さない", () => {
    const { detail } = splitMainDetailRows("mansion", MANSION_FIELDS, {
      price: "3980", propertyType: "中古マンション", buildingName: "平和台パーク", access: "徒歩5分",
      address: "東京都練馬区平和台一丁目", remarks: "", staff: "山田",
    });
    expect(detail).toEqual([{ label: "所在地", value: "東京都練馬区平和台一丁目" }]);
  });
  it("詳細: つながる項目を1行にまとめ、先頭の項目の位置に置く", () => {
    const { detail } = splitMainDetailRows("house", HOUSE_FIELDS, {
      address: "東京都練馬区富士見台二丁目", floor1Area: "50", floor2Area: "48.5",
      coverageRatio: "60", floorRatio: "200", roadKind: "公道", roadWidth: "5.0", roadDirections: ["東"],
    });
    expect(detail).toEqual([
      { label: "所在地", value: "東京都練馬区富士見台二丁目" },
      { label: "各階面積", value: "1階 50㎡ / 2階 48.5㎡" },
      { label: "接道", value: "東 / 公道 / 幅員5.0m" },
      { label: "建蔽率/容積率", value: "60％ / 200％" },
    ]);
  });
  it("詳細: うち消費税は課税のときだけ", () => {
    expect(splitMainDetailRows("house", HOUSE_FIELDS, { tax: "課税", taxAmount: "180" }).detail).toContainEqual({ label: "うち消費税", value: "180万円" });
    expect(splitMainDetailRows("house", HOUSE_FIELDS, { tax: "非課税", taxAmount: "180" }).detail).toEqual([]);
  });
  it("土地: 接道・建蔽率は主要に入り、詳細に重ねて出さない", () => {
    const { main, detail } = splitMainDetailRows("land", LAND_FIELDS, { roadKind: "公道", roadWidth: "4", coverageRatio: "60", floorRatio: "200" });
    expect(main.find((r) => r.label === "接道")?.value).toBe("公道 / 幅員4m");
    expect(detail.map((r) => r.label)).not.toContain("接道");
    expect(detail.map((r) => r.label)).not.toContain("建蔽率/容積率");
  });
});

describe("splitDetailColumns", () => {
  it("前半を左、後半を右(奇数は左が1行多い)", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, value: `${n}` }));
    const { left, right } = splitDetailColumns(rows);
    expect(left.map((r) => r.label)).toEqual(["L1", "L2", "L3"]);
    expect(right.map((r) => r.label)).toEqual(["L4", "L5"]);
  });
  it("0行は両方空", () => {
    expect(splitDetailColumns([])).toEqual({ left: [], right: [] });
  });
});
