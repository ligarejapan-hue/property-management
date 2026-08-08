import { describe, it, expect } from "vitest";
import { isRealCalendarDate } from "@/lib/calendar-date";

describe("isRealCalendarDate(@codex #364 R1)", () => {
  it("実在日は true(うるう年含む)", () => {
    expect(isRealCalendarDate("2026-08-08")).toBe(true);
    expect(isRealCalendarDate("2024-02-29")).toBe(true);
    expect(isRealCalendarDate("2026-12-31")).toBe(true);
  });
  it("形式は合うが実在しない日は false", () => {
    expect(isRealCalendarDate("2026-02-31")).toBe(false);
    expect(isRealCalendarDate("2026-99-99")).toBe(false);
    expect(isRealCalendarDate("2026-00-10")).toBe(false);
    expect(isRealCalendarDate("2026-02-29")).toBe(false); // 平年
  });
  it("形式外は false", () => {
    expect(isRealCalendarDate("2026/08/08")).toBe(false);
    expect(isRealCalendarDate("2026-8-8")).toBe(false);
    expect(isRealCalendarDate("")).toBe(false);
  });
});
