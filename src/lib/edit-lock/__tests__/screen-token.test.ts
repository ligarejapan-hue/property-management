import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readScreenTokenHash, hashScreenToken, readLockId } from "../screen-token";

describe("画面の合言葉", () => {
  it("ヘッダが無ければ null", () => {
    expect(readScreenTokenHash(new Request("http://x/"))).toBeNull();
  });
  it("空白だけのヘッダも null", () => {
    expect(readScreenTokenHash(new Request("http://x/", { headers: { "X-Edit-Screen": "   " } }))).toBeNull();
  });
  it("sha256 にして返す(生値は返さない)", () => {
    const token = "screen-abc";
    const expected = createHash("sha256").update(token).digest("hex");
    expect(hashScreenToken(token)).toBe(expected);
    expect(readScreenTokenHash(new Request("http://x/", { headers: { "X-Edit-Screen": token } }))).toBe(expected);
  });
});

describe("鍵の世代", () => {
  it("ヘッダが無ければ null", () => {
    expect(readLockId(new Request("http://x/"))).toBeNull();
  });
  it("空白だけのヘッダも null", () => {
    expect(readLockId(new Request("http://x/", { headers: { "X-Edit-Lock": "   " } }))).toBeNull();
  });
  it("そのまま返す(ハッシュ化はしない)", () => {
    const lockId = "11111111-1111-1111-1111-111111111111";
    expect(readLockId(new Request("http://x/", { headers: { "X-Edit-Lock": lockId } }))).toBe(lockId);
  });
});
