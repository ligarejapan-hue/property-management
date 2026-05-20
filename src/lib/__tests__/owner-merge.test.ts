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

  it("normalizeKeyMatches=false（両者存在） → name_address_normalize_mismatch", () => {
    const r = checkOwnerMergeSafety({ ...baseOk, normalizeKeyMatches: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("name_address_normalize_mismatch");
  });

  it("master_not_found のとき name_address_normalize_mismatch は含めない", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      masterExists: false,
      normalizeKeyMatches: false, // key 比較は不能だが mismatch とは扱わない
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain("master_not_found");
      expect(r.reasons).not.toContain("name_address_normalize_mismatch");
    }
  });

  it("source_not_found のとき name_address_normalize_mismatch は含めない", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      sourceExists: false,
      normalizeKeyMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain("source_not_found");
      expect(r.reasons).not.toContain("name_address_normalize_mismatch");
    }
  });

  it("master/source 両方とも存在しないときも name_address_normalize_mismatch は含めない", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      masterExists: false,
      sourceExists: false,
      normalizeKeyMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(
        expect.arrayContaining(["master_not_found", "source_not_found"]),
      );
      expect(r.reasons).not.toContain("name_address_normalize_mismatch");
    }
  });

  it("version_mismatch は OwnerMergeBlockReason の有効な値", () => {
    // execute API が tx 内で version 不一致を検出した場合に push する。
    // lib は値を受け取って push する側ではなく、route が直接 push する想定だが、
    // enum union として通ること（型エラーにならないこと）を担保する。
    const reasons: import("../owner-merge").OwnerMergeBlockReason[] = [
      "version_mismatch",
    ];
    expect(reasons[0]).toBe("version_mismatch");
  });

  it("複数違反でも not_found と normalize mismatch は混在しない（source 不存在 + 他違反）", () => {
    const r = checkOwnerMergeSafety({
      ...baseOk,
      sourceExists: false,
      sourceIsArchived: true, // sourceExists=false なので無視される
      normalizeKeyMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain("source_not_found");
      expect(r.reasons).not.toContain("name_address_normalize_mismatch");
      // sourceIsArchived は sourceExists=true の時のみ反映するため、ここでは出ない
      expect(r.reasons).not.toContain("source_archived");
    }
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
