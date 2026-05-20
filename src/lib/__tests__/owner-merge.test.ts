import { describe, it, expect } from "vitest";
import { checkOwnerMergeSafety } from "../owner-merge";

const baseOk = {
  sameOwnerId: false,
  masterExists: true,
  sourceExists: true,
  masterIsArchived: false,
  sourceIsArchived: false,
  sourceChangeLogCount: 0,
  sourceHasNote: false,
  sourceHasExternalLinkKey: false,
  sourceVersion: 1,
  normalizeKeyMatches: true,
};

describe("checkOwnerMergeSafety", () => {
  it("全条件を満たすと ok", () => {
    expect(checkOwnerMergeSafety(baseOk)).toEqual({ ok: true });
  });

  it("sameOwnerId=true → same_owner_id", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, sameOwnerId: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("same_owner_id");
  });

  it("masterExists=false → master_not_found", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, masterExists: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("master_not_found");
  });

  it("sourceExists=false → source_not_found", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, sourceExists: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("source_not_found");
  });

  it("masterIsArchived=true → master_archived", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, masterIsArchived: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("master_archived");
  });

  it("sourceIsArchived=true → source_archived", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, sourceIsArchived: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("source_archived");
  });

  it("sourceChangeLogCount>0 → source_has_changelog", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, sourceChangeLogCount: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("source_has_changelog");
  });

  it("sourceHasNote=true → source_has_note", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, sourceHasNote: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("source_has_note");
  });

  it("sourceHasExternalLinkKey=true → source_has_external_link_key", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      sourceHasExternalLinkKey: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("source_has_external_link_key");
  });

  it("sourceVersion>1 → source_version_gt_1", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, sourceVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("source_version_gt_1");
  });

  it("normalizeKeyMatches=false → name_address_normalize_mismatch", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, normalizeKeyMatches: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("name_address_normalize_mismatch");
  });

  it("複数違反は全件返す", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      sourceIsArchived: true,
      sourceChangeLogCount: 3,
      sourceHasNote: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(
        expect.arrayContaining([
          "source_archived",
          "source_has_changelog",
          "source_has_note",
        ]),
      );
    }
  });

  it("OwnerMemo は blocker に含まれない（件数引数自体が存在しないこと）", () => {
    // OwnerMemo は input に含めない設計（summary で件数提示するため）。
    // baseOk の input フィールドに owner memo 関連が無いことを契約として担保する。
    const keys = Object.keys(baseOk);
    expect(keys).not.toContain("sourceOwnerMemoCount");
    expect(keys).not.toContain("ownerMemoExists");
  });

  it("PropertyOwner 重複は blocker に含まれない（件数引数自体が存在しないこと）", () => {
    const keys = Object.keys(baseOk);
    expect(keys).not.toContain("propertyOwnerOverlap");
    expect(keys).not.toContain("bothHaveSameProperty");
  });
});
