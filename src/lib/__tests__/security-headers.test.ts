/**
 * 防御ヘッダの配線テスト。
 *
 * next.config.ts は型 import(NextConfig)のみで実行時は素のオブジェクトなので、
 * vitest から実体 import して headers() の戻りを直接検証できる(auth.ts と違い
 * next-auth 実体を引かない)。
 *
 * ⚠あえて入れないもの(Permissions-Policy / CSP)は「入っていないこと」も固定し、
 * 現地調査のカメラ・GPS を壊す将来変更や、Maps を割る雑な CSP を検知できるようにする。
 */
import { describe, it, expect } from "vitest";
// next.config.ts は拡張子なしで解決させる(vitest / ts の module 解決に委ねる)。
import nextConfig from "../../../next.config";

async function headerMap(): Promise<Record<string, string>> {
  const fn = (nextConfig as { headers?: () => Promise<unknown> }).headers;
  expect(typeof fn).toBe("function");
  const rules = (await fn!()) as Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
  // 全ルート(/:path*)に当たるルールを1つ持つこと。
  const all = rules.find((r) => r.source === "/:path*");
  expect(all, "全ルート(/:path*)向けのヘッダルールが必要").toBeTruthy();
  const map: Record<string, string> = {};
  for (const h of all!.headers) map[h.key.toLowerCase()] = h.value;
  return map;
}

describe("防御ヘッダ(next.config)", () => {
  it("X-Powered-By を出さない(poweredByHeader:false)", () => {
    expect((nextConfig as { poweredByHeader?: boolean }).poweredByHeader).toBe(
      false,
    );
  });

  it("クリックジャッキング防止(X-Frame-Options: SAMEORIGIN)", async () => {
    const m = await headerMap();
    expect(m["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("MIME スニッフィング防止(X-Content-Type-Options: nosniff)", async () => {
    const m = await headerMap();
    expect(m["x-content-type-options"]).toBe("nosniff");
  });

  it("Referrer-Policy を送出する", async () => {
    const m = await headerMap();
    expect(m["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("HSTS を送出する(HTTPS応答=Tailscale経路でのみ効く・preloadは付けない)", async () => {
    const m = await headerMap();
    expect(m["strict-transport-security"]).toMatch(/max-age=\d{7,}/);
    // tailnet ホスト名なので includeSubDomains / preload は付けない。
    expect(m["strict-transport-security"]).not.toContain("preload");
  });

  it("⚠カメラ/GPS を壊す Permissions-Policy を入れていない(現地調査が使う)", async () => {
    const m = await headerMap();
    expect(m["permissions-policy"]).toBeUndefined();
  });

  it("⚠地図を割りうる CSP を入れていない(別タスクで慎重に)", async () => {
    const m = await headerMap();
    expect(m["content-security-policy"]).toBeUndefined();
    expect(m["content-security-policy-report-only"]).toBeUndefined();
  });
});
