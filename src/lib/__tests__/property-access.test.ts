import { describe, it, expect } from "vitest";
import { canAccessPropertyRecord } from "../property-access";

const property = (createdBy: string, assignedTo: string | null) => ({
  createdBy,
  assignedTo,
});

describe("canAccessPropertyRecord", () => {
  it("admin はどの物件もアクセス可", () => {
    expect(
      canAccessPropertyRecord(
        { id: "u-admin", role: "admin" },
        property("u-other", "u-other2"),
      ),
    ).toBe(true);
  });

  it("office_staff はどの物件もアクセス可（field_staff 以外）", () => {
    expect(
      canAccessPropertyRecord(
        { id: "u-office", role: "office_staff" },
        property("u-other", null),
      ),
    ).toBe(true);
  });

  it("field_staff + createdBy 一致 → 可", () => {
    expect(
      canAccessPropertyRecord(
        { id: "u-fs", role: "field_staff" },
        property("u-fs", "u-other"),
      ),
    ).toBe(true);
  });

  it("field_staff + assignedTo 一致 → 可", () => {
    expect(
      canAccessPropertyRecord(
        { id: "u-fs", role: "field_staff" },
        property("u-other", "u-fs"),
      ),
    ).toBe(true);
  });

  it("field_staff + どちらも一致なし → 不可", () => {
    expect(
      canAccessPropertyRecord(
        { id: "u-fs", role: "field_staff" },
        property("u-other", "u-other2"),
      ),
    ).toBe(false);
  });

  it("field_staff + assignedTo=null かつ createdBy 不一致 → 不可", () => {
    expect(
      canAccessPropertyRecord(
        { id: "u-fs", role: "field_staff" },
        property("u-other", null),
      ),
    ).toBe(false);
  });
});
