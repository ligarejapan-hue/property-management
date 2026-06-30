import { describe, it, expect } from "vitest";
import { resolveAdjustTarget, buildDraftPatch, DESIGN_OPTIONS, APPEAL_OPTIONS } from "../sale-dm-letter/adjust-model";

describe("選択肢定数", () => {
  it("デザインは formal/soft/impact の3種", () => {
    expect(DESIGN_OPTIONS.map((o) => o.value)).toEqual(["formal", "soft", "impact"]);
  });
  it("訴求軸は price/inheritance/vacant/buyer の4種", () => {
    expect(APPEAL_OPTIONS.map((o) => o.value)).toEqual(["price", "inheritance", "vacant", "buyer"]);
  });
});

describe("resolveAdjustTarget", () => {
  it("全体タブは campaign スコープ", () => {
    expect(resolveAdjustTarget("campaign", { id: "r1" } as never)).toEqual({ scope: "campaign", draftId: null });
  });
  it("この通タブで selected があれば draft スコープ", () => {
    expect(resolveAdjustTarget("draft", { id: "r1" } as never)).toEqual({ scope: "draft", draftId: "r1" });
  });
  it("この通タブで selected が null なら draftId は null", () => {
    expect(resolveAdjustTarget("draft", null)).toEqual({ scope: "draft", draftId: null });
  });
});

describe("buildDraftPatch", () => {
  it("body のみ", () => {
    expect(buildDraftPatch({ body: "編集後" })).toEqual({ body: "編集後" });
  });
  it("型変更(variantId)のみ", () => {
    expect(buildDraftPatch({ variantId: "v2" })).toEqual({ variantId: "v2" });
  });
  it("未指定キーは入れない", () => {
    expect(buildDraftPatch({})).toEqual({});
  });
});
