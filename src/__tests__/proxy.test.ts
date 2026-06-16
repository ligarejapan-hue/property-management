/**
 * proxy（認証ミドルウェア）の公開パス挙動。
 *
 *  - /api/health は未認証でも素通しする（health は公開エンドポイント）。
 *  - 既存の保護パスは未認証だと /login へ redirect される（回帰ガード）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import proxy from "@/proxy";

function requestFor(pathname: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${pathname}`));
}

describe("proxy public paths", () => {
  const ORIGINAL_MOCK = process.env.NEXT_PUBLIC_USE_MOCK;

  beforeEach(() => {
    // mock bypass を無効化し、実際の公開パス判定を検証する。
    delete process.env.NEXT_PUBLIC_USE_MOCK;
  });

  afterEach(() => {
    if (ORIGINAL_MOCK === undefined) {
      delete process.env.NEXT_PUBLIC_USE_MOCK;
    } else {
      process.env.NEXT_PUBLIC_USE_MOCK = ORIGINAL_MOCK;
    }
  });

  it("未認証でも /api/health は素通しする（redirect しない）", async () => {
    const res = await proxy(requestFor("/api/health"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("未認証の保護パスは /login へ redirect する（回帰ガード）", async () => {
    const res = await proxy(requestFor("/api/properties"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location") ?? "").toContain("/login");
  });

  it("/api/health の完全一致のみ公開（前方一致 /api/health-xxx は保護）", async () => {
    const res = await proxy(requestFor("/api/health-secret"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location") ?? "").toContain("/login");
  });
});
