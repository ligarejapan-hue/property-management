import { describe, it, expect } from "vitest";
import { localizeOccupancy, normalizeOccupancyInput, occupancyOptionsFor, occupancyFitsType, OCCUPANCY_STATUS_OPTIONS } from "../property-types";

describe("土地の現況(2026-11-11 発注者指示)", () => {
  it("土地の選択肢は 更地・古屋あり・賃貸中・不明", () => {
    expect(occupancyOptionsFor("land").map((o) => o.label)).toEqual(["更地", "古屋あり", "賃貸中", "不明"]);
  });
  it("土地以外は今までどおり 空室・居住中・賃貸中・不明(更地・古屋ありは出さない)", () => {
    for (const t of ["apartment_unit", "house", null]) {
      expect(occupancyOptionsFor(t).map((o) => o.label)).toEqual(["空室", "居住中", "賃貸中", "不明"]);
    }
    expect(OCCUPANCY_STATUS_OPTIONS.map((o) => o.value)).toEqual(["vacant", "occupied", "rented", "unknown"]);
  });
  it("今の値が選択肢に無ければ日本語の名前で末尾に足す(重ねない)", () => {
    expect(occupancyOptionsFor("land", "occupied").at(-1)).toEqual({ value: "occupied", label: "居住中" });
    expect(occupancyOptionsFor("land", "rented")).toHaveLength(4);
  });
  it("更地・古屋ありは土地だけ。土地に前からある空室などは消さない", () => {
    expect(occupancyFitsType("land", "vacant_land")).toBe(true);
    expect(occupancyFitsType("apartment_unit", "vacant_land")).toBe(false);
    expect(occupancyFitsType("house", "old_house")).toBe(false);
    expect(occupancyFitsType(undefined, "old_house")).toBe(false);
    expect(occupancyFitsType("land", "vacant")).toBe(true);
    expect(occupancyFitsType("house", null)).toBe(true);
  });
  it("表示名と CSV の入力", () => {
    expect(localizeOccupancy("vacant_land")).toBe("更地");
    expect(localizeOccupancy("old_house")).toBe("古屋あり");
    expect(normalizeOccupancyInput("更地")).toBe("vacant_land");
    expect(normalizeOccupancyInput("古屋あり")).toBe("old_house");
    expect(normalizeOccupancyInput("古家あり")).toBe("old_house");
    expect(normalizeOccupancyInput("old_house")).toBe("old_house");
  });
});

describe("localizeOccupancy", () => {
  it("maps known occupancy enum values to Japanese labels", () => {
    expect(localizeOccupancy("vacant")).toBe("空室");
    // ★2026-10-14: 「入居中」を「居住中」「賃貸中」に分けた(既存の occupied は居住中)
    expect(localizeOccupancy("occupied")).toBe("居住中");
    expect(localizeOccupancy("rented")).toBe("賃貸中");
    expect(localizeOccupancy("unknown")).toBe("不明");
  });

  it("★CSV などの入力: 値も日本語の表示名も受け、知らない語は null(古い表示名「入居中」は居住中)", () => {
    expect(normalizeOccupancyInput("rented")).toBe("rented");
    expect(normalizeOccupancyInput("賃貸中")).toBe("rented");
    expect(normalizeOccupancyInput("居住中")).toBe("occupied");
    expect(normalizeOccupancyInput("入居中")).toBe("occupied");
    expect(normalizeOccupancyInput("空室")).toBe("vacant");
    expect(normalizeOccupancyInput("ほぼ空き")).toBeNull();
    expect(normalizeOccupancyInput("")).toBeNull();
  });

  it("returns null for null or undefined", () => {
    expect(localizeOccupancy(null)).toBeNull();
    expect(localizeOccupancy(undefined)).toBeNull();
  });

  it("passes through values that are not known enum keys", () => {
    expect(localizeOccupancy("更地")).toBe("更地");
  });
});
