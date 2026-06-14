import { describe, it, expect } from "vitest";
import {
  createRegistryFetchThrottle,
  type RegistryFetchThrottle,
} from "../throttle";
import { createTokenBucketLimiter } from "@/lib/token-bucket";

describe("createRegistryFetchThrottle", () => {
  it("最小間隔内の連続取得は 2 回目以降を拒否する（burst=1）", () => {
    const throttle = createRegistryFetchThrottle({ minIntervalMs: 60_000 });
    const t0 = 1_000_000;
    expect(throttle.tryAcquire("official", t0)).toBe(true);
    // 直後（間隔未満）は拒否。
    expect(throttle.tryAcquire("official", t0 + 1)).toBe(false);
    expect(throttle.tryAcquire("official", t0 + 30_000)).toBe(false);
  });

  it("最小間隔を超えたら再び許可する", () => {
    const throttle = createRegistryFetchThrottle({ minIntervalMs: 60_000 });
    const t0 = 2_000_000;
    expect(throttle.tryAcquire("official", t0)).toBe(true);
    expect(throttle.tryAcquire("official", t0 + 60_000)).toBe(true);
  });

  it("key ごとに独立して制御する", () => {
    const throttle = createRegistryFetchThrottle({ minIntervalMs: 60_000 });
    const t0 = 3_000_000;
    expect(throttle.tryAcquire("a", t0)).toBe(true);
    // 別 key は影響を受けない。
    expect(throttle.tryAcquire("b", t0)).toBe(true);
    // 同一 key の連続は拒否。
    expect(throttle.tryAcquire("a", t0)).toBe(false);
  });

  it("burst を上げるとその回数まで連続許可する", () => {
    const throttle = createRegistryFetchThrottle({
      minIntervalMs: 60_000,
      burst: 3,
    });
    const t0 = 4_000_000;
    expect(throttle.tryAcquire("official", t0)).toBe(true);
    expect(throttle.tryAcquire("official", t0)).toBe(true);
    expect(throttle.tryAcquire("official", t0)).toBe(true);
    // 4 回目はバースト枯渇で拒否。
    expect(throttle.tryAcquire("official", t0)).toBe(false);
  });

  it("既存 token-bucket（createTokenBucketLimiter）を再利用する（注入で同一挙動）", () => {
    // 新規アルゴリズムを発明していないことを、注入した token-bucket で固定する。
    const limiter = createTokenBucketLimiter({
      capacity: 1,
      refillPerSec: 1000 / 60_000,
    });
    const throttle: RegistryFetchThrottle = createRegistryFetchThrottle({
      limiter,
    });
    const t0 = 5_000_000;
    expect(throttle.tryAcquire("k", t0)).toBe(true);
    expect(throttle.tryAcquire("k", t0 + 1)).toBe(false);
  });

  it("不正な設定（minIntervalMs<=0 / burst<1）は throw する", () => {
    expect(() => createRegistryFetchThrottle({ minIntervalMs: 0 })).toThrow();
    expect(() => createRegistryFetchThrottle({ burst: 0 })).toThrow();
  });
});
