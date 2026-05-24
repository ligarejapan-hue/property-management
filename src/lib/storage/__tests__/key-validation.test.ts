/**
 * key-validation unit test (Phase 2 Codex P1).
 *
 * 全 storage adapter が共有する traversal validation。
 * isValidStorageKey / assertValidStorageKey の双方を網羅。
 */
import { describe, it, expect } from "vitest";
import {
  isValidStorageKey,
  assertValidStorageKey,
} from "../key-validation";

describe("isValidStorageKey", () => {
  it.each([
    "properties/abc/photos/1.jpg",
    "a/b/c/d.txt",
    "single.png",
    "深い/ネスト/日本語ファイル.pdf",
  ])("valid: %s", (k) => {
    expect(isValidStorageKey(k)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["dot", "."],
    ["dotdot", ".."],
    ["absolute", "/etc/passwd"],
    ["leading ../", "../etc/passwd"],
    ["middle ..", "properties/1/photos/../secret.jpg"],
    ["trailing /..", "properties/1/.."],
    ["leading ./", "./a"],
    ["middle ./", "a/./b"],
    ["double slash", "a//b"],
    ["leading double slash", "//a"],
    ["trailing slash", "a/b/"],
    ["backslash", "properties\\1\\secret.jpg"],
    ["mixed slash", "a/b\\c"],
  ])("invalid (%s): %s", (_label, k) => {
    expect(isValidStorageKey(k)).toBe(false);
  });

  it("non-string types are invalid", () => {
    expect(isValidStorageKey(undefined)).toBe(false);
    expect(isValidStorageKey(null)).toBe(false);
    expect(isValidStorageKey(123)).toBe(false);
    expect(isValidStorageKey({})).toBe(false);
  });
});

describe("assertValidStorageKey", () => {
  it("valid key は throw しない", () => {
    expect(() => assertValidStorageKey("properties/a/photos/x.jpg")).not.toThrow();
  });

  it("invalid key は 'path traversal' を含むメッセージで throw", () => {
    expect(() => assertValidStorageKey("../etc/passwd")).toThrow(
      /path traversal/,
    );
    expect(() => assertValidStorageKey("a/../b")).toThrow(/path traversal/);
    expect(() => assertValidStorageKey("a\\b")).toThrow(/path traversal/);
    expect(() => assertValidStorageKey("/abs")).toThrow(/path traversal/);
    expect(() => assertValidStorageKey("")).toThrow(/path traversal/);
  });
});
