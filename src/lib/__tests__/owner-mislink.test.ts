import { describe, it, expect } from "vitest";
import { checkOwnerMislinkSafety } from "../owner-mislink";

const baseOk = {
  operation: "remove" as const,
  hasTargetForRelink: true,
  sameOwnerId: false,
  propertyOwnerExists: true,
  propertyOwnerPropertyIdMatches: true,
  propertyOwnerOwnerIdMatches: true,
  propertyExists: true,
  propertyIsArchived: false,
  propertyVersionMatches: true,
  currentOwnerExists: true,
  currentOwnerVersionMatches: true,
  targetOwnerExists: true,
  targetOwnerIsArchived: false,
  targetOwnerVersionMatches: true,
  targetAlreadyLinked: false,
};

const baseRelinkOk = { ...baseOk, operation: "relink" as const };

describe("checkOwnerMislinkSafety", () => {
  it("remove で全条件 OK → ok", () => {
    expect(checkOwnerMislinkSafety(baseOk)).toEqual({ ok: true });
  });

  it("relink で全条件 OK → ok", () => {
    expect(checkOwnerMislinkSafety(baseRelinkOk)).toEqual({ ok: true });
  });

  it("operation が null → missing_operation", () => {
    const r = checkOwnerMislinkSafety({ ...baseOk, operation: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("missing_operation");
  });

  it("relink で target なし → missing_target_for_relink", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      hasTargetForRelink: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("missing_target_for_relink");
  });

  it("relink で sameOwnerId → same_owner_id", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      sameOwnerId: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("same_owner_id");
  });

  it("PropertyOwner 不存在 → property_owner_not_found", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      propertyOwnerExists: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("property_owner_not_found");
  });

  it("PropertyOwner.propertyId 不一致 → property_owner_state_mismatch", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      propertyOwnerPropertyIdMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("property_owner_state_mismatch");
  });

  it("PropertyOwner.ownerId 不一致 → current_owner_id_mismatch", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      propertyOwnerOwnerIdMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("current_owner_id_mismatch");
  });

  it("property 不存在 → property_not_found", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      propertyExists: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("property_not_found");
  });

  it("property archived → property_archived", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      propertyIsArchived: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("property_archived");
  });

  it("currentOwner 不存在 → current_owner_not_found", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      currentOwnerExists: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("current_owner_not_found");
  });

  it("relink target 不存在 → target_owner_not_found", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      targetOwnerExists: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("target_owner_not_found");
  });

  it("relink target archived → target_owner_archived", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      targetOwnerIsArchived: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("target_owner_archived");
  });

  it("relink で target が同 property に既に紐付き → target_already_linked", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      targetAlreadyLinked: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("target_already_linked");
  });

  it("property version 不一致 → version_mismatch", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      propertyVersionMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("version_mismatch");
  });

  it("currentOwner version 不一致 → version_mismatch", () => {
    const r = checkOwnerMislinkSafety({
      ...baseOk,
      currentOwnerVersionMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("version_mismatch");
  });

  it("relink targetOwner version 不一致 → version_mismatch", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      targetOwnerVersionMatches: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("version_mismatch");
  });

  it("currentOwner archived は blocker にしない（remove / relink どちらも）", () => {
    // currentOwnerExists=true で archived 情報は入力に含まれない → blocker 対象外
    expect(checkOwnerMislinkSafety(baseOk)).toEqual({ ok: true });
    expect(checkOwnerMislinkSafety(baseRelinkOk)).toEqual({ ok: true });
  });

  it("複数違反は全件返す", () => {
    const r = checkOwnerMislinkSafety({
      ...baseRelinkOk,
      sameOwnerId: true,
      propertyIsArchived: true,
      targetOwnerIsArchived: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toEqual(
        expect.arrayContaining([
          "same_owner_id",
          "property_archived",
          "target_owner_archived",
        ]),
      );
    }
  });
});
