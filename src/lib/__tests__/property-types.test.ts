import { describe, it, expect } from "vitest";
import { localizeOccupancy, normalizeOccupancyInput } from "../property-types";

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
