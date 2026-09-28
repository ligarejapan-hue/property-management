import { describe, it, expect } from "vitest";
import { saleDmCampaignBodySchema } from "@/lib/validators-sale-dm";

const base = {
  name: "テスト発送",
  options: {
    designTemplate: "formal",
    tone: "standard",
    length: "medium",
    appeal: "price",
    strength: "medium",
  },
};

describe("saleDmCampaignBodySchema: defaultScenarioId(種類つきの発送・設計 §3.3.0)", () => {
  it("未指定は許可され、値は undefined のまま", () => {
    const r = saleDmCampaignBodySchema.parse({ ...base });
    expect(r.defaultScenarioId).toBeUndefined();
  });

  it("null は許可され、種類を使わない発送を表す", () => {
    const r = saleDmCampaignBodySchema.parse({ ...base, defaultScenarioId: null });
    expect(r.defaultScenarioId).toBeNull();
  });

  it("大文字混じりの uuid は小文字化される", () => {
    const upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    const r = saleDmCampaignBodySchema.parse({ ...base, defaultScenarioId: upper });
    expect(r.defaultScenarioId).toBe(upper.toLowerCase());
  });

  it("uuid ではない値は失敗する", () => {
    expect(() => saleDmCampaignBodySchema.parse({ ...base, defaultScenarioId: "not-a-uuid" })).toThrow();
  });
});
