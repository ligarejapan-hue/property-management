/**
 * Google ドライブ連携(第2段 2a・2026-10-24): 認可の往復の純関数。
 * - 同意画面の URL(ドライブ全体のスコープ・オフライン・毎回同意=refresh token を必ずもらう)
 * - state(CSRF 対策)は HMAC 署名つき・利用者に紐づく・10分で切れる
 * - コード交換・トークン更新は fetch を差し込めるようにして、応答の形だけを確かめる
 */
import { describe, it, expect } from "vitest";
import {
  buildConsentUrl,
  signOauthState,
  verifyOauthState,
  exchangeAuthorizationCode,
  refreshAccessToken,
  DRIVE_SCOPE,
  DriveAuthError,
} from "../oauth";

const SECRET = "test-secret-32-bytes-long-string!!";
const NOW = Date.UTC(2026, 9, 24, 1, 0, 0);

describe("同意画面の URL", () => {
  it("ドライブ全体のスコープ・offline・prompt=consent・state・戻り先を含む", () => {
    const url = new URL(
      buildConsentUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri: "https://pm.example/api/drive/oauth/callback", state: "st" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://pm.example/api/drive/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });
  it("スコープはドライブ全体(人が置いたファイルを読むため・drive.file ではない)", () => {
    expect(DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive");
  });
});

describe("state(CSRF 対策)", () => {
  it("同じ利用者・10分以内なら通る", () => {
    const st = signOauthState({ secret: SECRET, userId: "u1", nowMs: NOW });
    expect(verifyOauthState({ secret: SECRET, state: st, userId: "u1", nowMs: NOW + 9 * 60_000 })).toBe(true);
  });
  it("★別の利用者・期限切れ・改ざん・別の鍵は通らない", () => {
    const st = signOauthState({ secret: SECRET, userId: "u1", nowMs: NOW });
    expect(verifyOauthState({ secret: SECRET, state: st, userId: "u2", nowMs: NOW })).toBe(false);
    expect(verifyOauthState({ secret: SECRET, state: st, userId: "u1", nowMs: NOW + 11 * 60_000 })).toBe(false);
    expect(verifyOauthState({ secret: SECRET, state: st + "x", userId: "u1", nowMs: NOW })).toBe(false);
    expect(verifyOauthState({ secret: "other", state: st, userId: "u1", nowMs: NOW })).toBe(false);
    expect(verifyOauthState({ secret: SECRET, state: "", userId: "u1", nowMs: NOW })).toBe(false);
    expect(verifyOauthState({ secret: SECRET, state: "a.b.c.d", userId: "u1", nowMs: NOW })).toBe(false);
  });
  it("state は URL に入れられる文字だけ・毎回違う(乱数入り)", () => {
    const a = signOauthState({ secret: SECRET, userId: "u1", nowMs: NOW });
    const b = signOauthState({ secret: SECRET, userId: "u1", nowMs: NOW });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  (f as unknown as { calls: typeof calls }).calls = calls;
  return f;
}
const callsOf = (f: typeof fetch) => (f as unknown as { calls: { url: string; init?: RequestInit }[] }).calls;

describe("コードの交換", () => {
  it("token の口に form で送り、refresh_token と access_token を返す", async () => {
    const f = fakeFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 3599, token_type: "Bearer" });
    const r = await exchangeAuthorizationCode(
      { code: "c0de", clientId: "cid", clientSecret: "sec", redirectUri: "https://pm.example/cb" },
      f,
    );
    expect(r).toEqual({ accessToken: "at", refreshToken: "rt", expiresInSec: 3599 });
    const c = callsOf(f)[0];
    expect(c.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(c.init?.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("c0de");
    expect(form.get("redirect_uri")).toBe("https://pm.example/cb");
    expect(form.get("client_secret")).toBe("sec");
  });
  it("★refresh_token が返らなければ失敗(同意をやり直してもらう)", async () => {
    const f = fakeFetch(200, { access_token: "at", expires_in: 3599 });
    await expect(
      exchangeAuthorizationCode({ code: "c", clientId: "cid", clientSecret: "sec", redirectUri: "https://pm.example/cb" }, f),
    ).rejects.toMatchObject({ code: "no_refresh_token" });
  });
  it("Google が 400 を返したら error の種類を持った失敗", async () => {
    const f = fakeFetch(400, { error: "invalid_grant", error_description: "Bad Request" });
    await expect(
      exchangeAuthorizationCode({ code: "c", clientId: "cid", clientSecret: "sec", redirectUri: "https://pm.example/cb" }, f),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("アクセストークンの更新", () => {
  it("refresh_token で access_token をもらう", async () => {
    const f = fakeFetch(200, { access_token: "at2", expires_in: 3599 });
    const r = await refreshAccessToken({ refreshToken: "rt", clientId: "cid", clientSecret: "sec" }, f);
    expect(r).toEqual({ accessToken: "at2", expiresInSec: 3599 });
    const form = new URLSearchParams(String(callsOf(f)[0].init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt");
  });
  it("★invalid_grant(認可の取り消し・失効)は DriveAuthError(code=invalid_grant)=再接続が要る", async () => {
    const f = fakeFetch(400, { error: "invalid_grant" });
    const err = await refreshAccessToken({ refreshToken: "rt", clientId: "cid", clientSecret: "sec" }, f).catch((e) => e);
    expect(err).toBeInstanceOf(DriveAuthError);
    expect(err.code).toBe("invalid_grant");
    expect(err.needsReconnect).toBe(true);
  });
});
