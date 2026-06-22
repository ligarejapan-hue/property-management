import { describe, it, expect } from "vitest";
import { deriveOutcome } from "../sale-dm-letter/outcome";

describe("deriveOutcome", () => {
  it("どちらの反響シグナルも無ければ none", () => {
    expect(deriveOutcome({ lpFirstAccessAt: null, phoneInquiryAt: null })).toBe("none");
  });
  it("LP アクセスがあれば inquiry", () => {
    expect(deriveOutcome({ lpFirstAccessAt: new Date(), phoneInquiryAt: null })).toBe("inquiry");
  });
  it("電話があれば inquiry", () => {
    expect(deriveOutcome({ lpFirstAccessAt: null, phoneInquiryAt: new Date() })).toBe("inquiry");
  });
  it("両方あれば inquiry", () => {
    expect(deriveOutcome({ lpFirstAccessAt: new Date(), phoneInquiryAt: new Date() })).toBe("inquiry");
  });
});
