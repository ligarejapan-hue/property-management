import { describe, it, expect } from "vitest";
import {
  decideRate,
  createRateLimiter,
  clientRateKey,
} from "../public-rate-limit";

// 公開エンドポイント(認証なし)の回数制限。純関数 decideRate を核にし、
// createRateLimiter は保持(Map)と上限(maxKeys)だけを足す。

describe("decideRate(純関数・スライディングウィンドウ)", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("窓内の件数が limit 未満なら許可し、今回のヒットを加えて返す", () => {
    const r = decideRate([1_000, 2_000], 3_000, rule);
    expect(r.allowed).toBe(true);
    expect(r.hits).toEqual([1_000, 2_000, 3_000]);
  });

  it("limit に達していたら拒否する(ヒットは加えない=拒否連打で窓が伸びない)", () => {
    const r = decideRate([1_000, 2_000, 3_000], 4_000, rule);
    expect(r.allowed).toBe(false);
    expect(r.hits).toEqual([1_000, 2_000, 3_000]);
  });

  it("窓の外に出た古いヒットは数えず、掃除して返す", () => {
    const r = decideRate([0, 1_000, 2_000], 61_500, rule);
    // 0 と 1_000 は 61_500-60_000=1_500 より前 → 落ちる。残り 2_000 + 今回。
    expect(r.allowed).toBe(true);
    expect(r.hits).toEqual([2_000, 61_500]);
  });

  it("入力の配列を破壊しない", () => {
    const hits = [1_000];
    decideRate(hits, 2_000, rule);
    expect(hits).toEqual([1_000]);
  });
});

describe("createRateLimiter(保持+鍵上限)", () => {
  it("鍵ごとに独立して数える", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.hit("a", 1_000)).toBe(true);
    expect(rl.hit("a", 2_000)).toBe(false);
    expect(rl.hit("b", 2_000)).toBe(true);
  });

  it("窓が過ぎればまた許可される", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(rl.hit("a", 0)).toBe(true);
    expect(rl.hit("a", 500)).toBe(false);
    expect(rl.hit("a", 1_501)).toBe(true);
  });

  it("鍵が maxKeys を超えたら期限切れを掃除し、それでも溢れる新鍵は onOverflow に従う", () => {
    const deny = createRateLimiter(
      { limit: 10, windowMs: 60_000 },
      { maxKeys: 2, onOverflow: "deny" },
    );
    expect(deny.hit("k1", 1_000)).toBe(true);
    expect(deny.hit("k2", 1_000)).toBe(true);
    // 3つ目の鍵: 期限切れ無し → 溢れ → deny は拒否(書き込み系の守り)
    expect(deny.hit("k3", 1_000)).toBe(false);

    const allow = createRateLimiter(
      { limit: 10, windowMs: 60_000 },
      { maxKeys: 2, onOverflow: "allow" },
    );
    expect(allow.hit("k1", 1_000)).toBe(true);
    expect(allow.hit("k2", 1_000)).toBe(true);
    // allow は「制限は尽力ベース」= 溢れても通す(読み取り系で正規利用者を巻き込まない)
    expect(allow.hit("k3", 1_000)).toBe(true);
    // 窓が過ぎた鍵は掃除され、新しい鍵が入れる
    expect(deny.hit("k4", 62_000)).toBe(true);
  });
});

describe("clientRateKey(送信元IPの鍵)", () => {
  it("x-real-ip(本番nginxが実IPで上書き設定)を最優先で使う", () => {
    const h = new Headers({
      "x-real-ip": "198.51.100.7",
      "x-forwarded-for": "spoofed-by-client, 198.51.100.7",
    });
    expect(clientRateKey(h)).toBe("198.51.100.7");
  });

  it("x-real-ip が無ければ x-forwarded-for の**末尾**値(プロキシが追記した側)を使う", () => {
    // 先頭はクライアント申告(偽装可能)。末尾が nginx の $proxy_add_x_forwarded_for の追記分。
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(clientRateKey(h)).toBe("203.0.113.9");
  });

  it("どちらも無ければ unknown", () => {
    expect(clientRateKey(new Headers())).toBe("unknown");
  });

  it("異常に長い値は切り詰める(鍵の肥大でメモリを膨らませない)", () => {
    const h = new Headers({ "x-forwarded-for": "a".repeat(500) });
    expect(clientRateKey(h).length).toBeLessThanOrEqual(64);
  });
});
