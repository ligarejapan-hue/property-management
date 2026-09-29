import { describe, it, expect } from "vitest";
import { todayTomorrowJst } from "@/lib/agent-inquiry/jst-range";

describe("今日・明日(JST)", () => {
  it.each([
    ["2026-09-30T14:59:59Z", "2026-09-29T15:00:00.000Z", "2026-10-01T15:00:00.000Z"],
    ["2026-09-30T15:00:00Z", "2026-09-30T15:00:00.000Z", "2026-10-02T15:00:00.000Z"],
  ])("%s", (now, from, to) => {
    const r = todayTomorrowJst(new Date(now));
    expect([r.from.toISOString(), r.to.toISOString()]).toEqual([from, to]);
  });
});
