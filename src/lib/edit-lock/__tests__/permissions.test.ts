import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api-helpers", () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, message: string, code = "ERROR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});

import { assertCanLockOwner, assertCanLockProperty, canWriteOwnerAnyField } from "../permissions";

const P = (...entries: [string, string][]) =>
  entries.map(([resource, action]) => ({ resource, action, granted: true }));

describe("所有者の鍵", () => {
  it("owner:write だけでは取れない(項目の書込権限が要る)", () => {
    expect(() => assertCanLockOwner(P(["owner", "read"], ["owner", "write"]))).toThrowError(/権限/);
  });
  it("項目の書込権限が1つでもあれば取れる", () => {
    expect(canWriteOwnerAnyField(P(["owner", "write"], ["owner_name", "full"]))).toBe(true);
    expect(() =>
      assertCanLockOwner(P(["owner", "read"], ["owner", "write"], ["owner_name", "full"])),
    ).not.toThrow();
  });
  it("owner:write が無ければ取れない", () => {
    expect(() => assertCanLockOwner(P(["owner_name", "full"]))).toThrowError(/権限/);
  });
  it("読めない利用者は取れない(書きだけ与えられている場合)", () => {
    expect(() => assertCanLockOwner(P(["owner", "write"], ["owner_name", "full"]))).toThrowError(/権限/);
  });
});

describe("物件の鍵", () => {
  const prop = { createdBy: "u1", assignedTo: null };
  it("property:write が無ければ 403", () => {
    expect(() =>
      assertCanLockProperty({ id: "u1", role: "general" }, P(["property", "read"]), prop),
    ).toThrowError(/権限/);
  });
  it("property:read が無ければ 403(書きだけ与えられている場合)", () => {
    expect(() =>
      assertCanLockProperty({ id: "u1", role: "general" }, P(["property", "write"]), prop),
    ).toThrowError(/権限/);
  });
  it("アルバイトは担当外なら 403", () => {
    expect(() =>
      assertCanLockProperty(
        { id: "u2", role: "field_staff" },
        P(["property", "read"], ["property", "write"]),
        prop,
      ),
    ).toThrowError(/権限/);
  });
  it("アルバイトでも担当なら取れる", () => {
    expect(() =>
      assertCanLockProperty(
        { id: "u1", role: "field_staff" },
        P(["property", "read"], ["property", "write"]),
        prop,
      ),
    ).not.toThrow();
  });
});
