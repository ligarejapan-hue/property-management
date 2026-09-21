import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";

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

import { ApiError } from "@/lib/api-helpers";
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
  it("前後の空白を落として返す", () => {
    const lockId = "11111111-1111-1111-1111-111111111111";
    expect(readLockId(new Request("http://x/", { headers: { "X-Edit-Lock": `  ${lockId}  ` } }))).toBe(lockId);
  });
  // review Minor 1(H7レビュー): 大文字混じりの uuid は小文字化して返す。
  // service.ts の `row.id === input.lockId` は素の文字列比較で、DB から返る
  // "id" 列は常に小文字なので、正規化しないと大文字混じりの画面の保存が
  // 常に 423 EDIT_LOCK_STALE になる。
  it("大文字混じりの uuid は小文字化して返す(正規化する)", () => {
    const lockId = "11111111-1111-1111-1111-111111111111";
    expect(
      readLockId(new Request("http://x/", { headers: { "X-Edit-Lock": lockId.toUpperCase() } })),
    ).toBe(lockId);
  });

  // ⚠review Important 3: この検査は「lockId を今すぐ SQL に bind すると 500 になる」
  // からではない(assertNotEditLockedByOther は lockId を JS の文字列比較にしか
  // 使っておらず、SQL には bind していない)。**入口の約束**として、不正な形式の
  // 値をここで 400 にしておけば、将来 lockId を SQL 側の判定に使う実装に変わっても
  // 22P02 の 500 にはならない。
  it("uuid の形をしていなければ ApiError(400, EDIT_LOCK_ID_INVALID) を投げる", () => {
    expect(() => readLockId(new Request("http://x/", { headers: { "X-Edit-Lock": "not-a-uuid" } }))).toThrowError(
      ApiError as unknown as new (...args: unknown[]) => Error,
    );
    try {
      readLockId(new Request("http://x/", { headers: { "X-Edit-Lock": "not-a-uuid" } }));
      throw new Error("unreachable");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).code).toBe("EDIT_LOCK_ID_INVALID");
    }
  });
});
