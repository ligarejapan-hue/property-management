import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number; code: string;
    constructor(status: number, message: string, code = "ERROR") { super(message); this.status = status; this.code = code; }
  }
  return { ApiError: MockApiError };
});

import { reserveSplitSlot } from "../slot";

describe("reserveSplitSlot(まとめてある PDF の口の席)", () => {
  it("席が取れれば返す関数で返す", () => {
    const release = vi.fn();
    expect(reserveSplitSlot(() => release)).toBe(release);
  });

  it("席が埋まっていれば 503(本文を読む前に断る)", () => {
    expect(() => reserveSplitSlot(() => null)).toThrow(expect.objectContaining({ status: 503, code: "BUSY" }));
  });

  it("口では大きさによらず席を取る(8MB 超だけの reserveLargePdfSlot を使わない)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["split", "split-analyze"]) {
      const src = readFileSync(`src/app/api/properties/[id]/attachments/${f}/route.ts`, "utf8");
      expect(src).toContain("releaseSlot = reserveSplitSlot();");
      expect(src).not.toContain("reserveLargePdfSlot(");
    }
  });
});
