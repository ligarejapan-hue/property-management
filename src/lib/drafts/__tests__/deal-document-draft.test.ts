import { describe, expect, it } from "vitest";
import { DRAFT_PREFIX, DRAFT_SCREENS } from "../draft-store";
import { dealDocumentDraftKey, parseDealDocumentDraft, sameAsInitial } from "../screens/deal-document";

describe("取引の書類の発行の小窓の控え(第2段階 §3.2)", () => {
  it("画面の名前を足し、取引と書類の種類ごとの鍵にする", () => {
    expect(DRAFT_SCREENS).toContain("deal-document");
    expect(dealDocumentDraftKey("d-1", "seller_survey")).toBe(`${DRAFT_PREFIX}deal-document:d-1:seller_survey`);
  });
  it("形の合う控えだけ戻す", () => {
    expect(parseDealDocumentDraft({ rev: 1, values: { a: "x", b: ["y"], c: null } })).toEqual({ rev: 1, values: { a: "x", b: ["y"], c: null } });
    for (const bad of [null, "x", {}, { rev: 2, values: {} }, { rev: 1, values: [] }, { rev: 1, values: {}, extra: 1 }]) {
      expect(parseDealDocumentDraft(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("初めの値(前回の入力・初期値)から変えていなければ控えない", () => {
    const empty = sameAsInitial({ a: "x", b: null });
    expect(empty({ rev: 1, values: { a: "x", b: null } })).toBe(true);
    expect(empty({ rev: 1, values: { a: "y", b: null } })).toBe(false);
  });
});
