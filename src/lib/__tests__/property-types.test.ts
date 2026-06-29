import { describe, it, expect } from "vitest";
import { localizeOccupancy } from "../property-types";

describe("localizeOccupancy", () => {
  it("maps known occupancy enum values to Japanese labels", () => {
    expect(localizeOccupancy("vacant")).toBe("空室");
    expect(localizeOccupancy("occupied")).toBe("入居中");
    expect(localizeOccupancy("unknown")).toBe("不明");
  });

  it("returns null for null or undefined", () => {
    expect(localizeOccupancy(null)).toBeNull();
    expect(localizeOccupancy(undefined)).toBeNull();
  });

  it("passes through values that are not known enum keys", () => {
    expect(localizeOccupancy("更地")).toBe("更地");
  });
});
