import { describe, it, expect } from "vitest";
import { roleLevel, canSee } from "../roles";

describe("roleLevel", () => {
  it("3ロールを 1/2/3 に写像する", () => {
    expect(roleLevel("field_staff")).toBe(1);
    expect(roleLevel("office_staff")).toBe(2);
    expect(roleLevel("admin")).toBe(3);
  });
  it("大文字も許容する(ADMIN)", () => {
    expect(roleLevel("ADMIN")).toBe(3);
  });
  it("未知・未設定は現場相当(1)にフォールバック", () => {
    expect(roleLevel("VIEWER")).toBe(1);
    expect(roleLevel(undefined)).toBe(1);
    expect(roleLevel(null)).toBe(1);
    expect(roleLevel("")).toBe(1);
  });
});

describe("canSee", () => {
  it("admin は全ての minRole を満たす", () => {
    expect(canSee("admin", "field_staff")).toBe(true);
    expect(canSee("admin", "office_staff")).toBe(true);
    expect(canSee("admin", "admin")).toBe(true);
  });
  it("field_staff は office/admin 限定を見られない", () => {
    expect(canSee("field_staff", "field_staff")).toBe(true);
    expect(canSee("field_staff", "office_staff")).toBe(false);
    expect(canSee("field_staff", "admin")).toBe(false);
  });
  it("office_staff は admin 限定を見られない", () => {
    expect(canSee("office_staff", "office_staff")).toBe(true);
    expect(canSee("office_staff", "admin")).toBe(false);
  });
});
