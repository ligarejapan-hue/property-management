import { describe, it, expect } from "vitest";
import { MockLetterProvider } from "../sale-dm-letter/providers/mock";

describe("MockLetterProvider", () => {
  it("name は 'mock'", () => {
    expect(new MockLetterProvider().name).toBe("mock");
  });
  it("body を決定的に返す(外部I/Oなし)", async () => {
    const p = new MockLetterProvider();
    const r1 = await p.generate({ system: "S", user: "宛名: 田中 一郎 様" });
    const r2 = await p.generate({ system: "S", user: "宛名: 田中 一郎 様" });
    expect(r1.body).toBe(r2.body);
    expect(r1.body.length).toBeGreaterThan(0);
  });
});
