import { describe, it, expect } from "vitest";
import { isScenarioCampaign, expectedLpVariantId, isValidScenarioPair } from "@/lib/sale-dm-letter/scenario-campaign";

const SC = { defaultScenarioId: "inh" };
const LEGACY = { defaultScenarioId: null };
const L = (id: string, scenarioId: string | null) => ({ id, scenarioId });

describe("種類つきの発送と組の決まり(spec §3.3.0)", () => {
  it("種類つきかどうかは defaultScenarioId だけで決まる", () => {
    expect(isScenarioCampaign(SC)).toBe(true);
    expect(isScenarioCampaign(LEGACY)).toBe(false);
  });
  it("総当たり: 種類1〜3 × LPあり/なし × 付けたLP", () => {
    const kinds = ["inh", "vac", "area"];
    for (let n = 1; n <= 3; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        const scen = kinds.slice(0, n);
        const lps = scen.filter((_, i) => mask & (1 << i)).map((s) => L(`lp-${s}`, s));
        for (const s of scen) {
          const letter = L(`v-${s}`, s);
          const expected = lps.some((l) => l.scenarioId === s) ? `lp-${s}` : null;
          expect(expectedLpVariantId(letter, lps)).toBe(expected);
          for (const candidate of [null, ...lps.map((l) => l.id), "lp-other"]) {
            expect(isValidScenarioPair(SC, letter, candidate, lps), `${s} ${candidate}`).toBe(candidate === expected);
          }
        }
      }
    }
  });
  it("種類なしの発送では何でも通る(今までの作り方)", () => {
    expect(isValidScenarioPair(LEGACY, L("v1", null), "lp-x", [L("lp-x", null)])).toBe(true);
  });
  it("種類つきの発送で、写していない手紙の型(scenarioId=null)は組として不正", () => {
    expect(isValidScenarioPair(SC, L("v1", null), null, [])).toBe(false);
  });
});
