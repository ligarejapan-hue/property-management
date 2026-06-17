import { describe, it, expect } from "vitest";
import { shouldOfferOcrDraft } from "../visibility";
import { reliabilityFromConfidence } from "../types";

describe("shouldOfferOcrDraft", () => {
  it("likely_scanned ∧ ocrDraftAvailable → true", () => {
    expect(
      shouldOfferOcrDraft({ isLikelyScanned: true, ocrDraftAvailable: true }),
    ).toBe(true);
  });
  it("digital-native(!likely_scanned) → false（非回帰の要）", () => {
    expect(
      shouldOfferOcrDraft({ isLikelyScanned: false, ocrDraftAvailable: true }),
    ).toBe(false);
  });
  it("capability false（未設定 or 非admin）→ false", () => {
    expect(
      shouldOfferOcrDraft({ isLikelyScanned: true, ocrDraftAvailable: false }),
    ).toBe(false);
  });
});

describe("reliabilityFromConfidence", () => {
  it("0.7 以上 → high", () => expect(reliabilityFromConfidence(0.8)).toBe("high"));
  it("0.4〜0.7 → medium", () => expect(reliabilityFromConfidence(0.5)).toBe("medium"));
  it("0.4 未満 → low", () => expect(reliabilityFromConfidence(0.2)).toBe("low"));
  it("NaN → low", () => expect(reliabilityFromConfidence(Number.NaN)).toBe("low"));
});
