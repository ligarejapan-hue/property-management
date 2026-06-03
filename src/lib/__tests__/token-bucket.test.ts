/**
 * S1b-3: in-memory token-bucket limiter（純粋・node 環境、nowMs を明示渡し）。
 */
import { describe, it, expect } from "vitest";
import { createTokenBucketLimiter } from "@/lib/token-bucket";

describe("createTokenBucketLimiter", () => {
  it("capacity まで連続消費でき、その後 false（429 相当）", () => {
    const limiter = createTokenBucketLimiter({ capacity: 3, refillPerSec: 1 });
    expect(limiter.tryConsume("u1", 0)).toBe(true);
    expect(limiter.tryConsume("u1", 0)).toBe(true);
    expect(limiter.tryConsume("u1", 0)).toBe(true);
    expect(limiter.tryConsume("u1", 0)).toBe(false);
  });

  it("時間経過で補充される", () => {
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSec: 1 });
    expect(limiter.tryConsume("u1", 0)).toBe(true);
    expect(limiter.tryConsume("u1", 0)).toBe(true);
    expect(limiter.tryConsume("u1", 0)).toBe(false);
    // 1 秒後に 1 トークン補充
    expect(limiter.tryConsume("u1", 1000)).toBe(true);
    expect(limiter.tryConsume("u1", 1000)).toBe(false);
  });

  it("key（ユーザー）ごとに独立", () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
    expect(limiter.tryConsume("u1", 0)).toBe(true);
    expect(limiter.tryConsume("u1", 0)).toBe(false);
    // 別ユーザーは影響を受けない
    expect(limiter.tryConsume("u2", 0)).toBe(true);
  });

  it("補充は capacity を超えない", () => {
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSec: 1 });
    expect(limiter.tryConsume("u1", 0)).toBe(true); // 残 1
    // 長時間経過しても capacity(2) までしか戻らない → 2 回だけ
    expect(limiter.tryConsume("u1", 100000)).toBe(true);
    expect(limiter.tryConsume("u1", 100000)).toBe(true);
    expect(limiter.tryConsume("u1", 100000)).toBe(false);
  });
});
