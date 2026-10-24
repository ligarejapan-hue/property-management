/**
 * Google ドライブ連携(第2段・2026-10-24): 認可(OAuth 2.0)の往復。
 *
 * - 同意画面の URL・state(CSRF 対策)・コードの交換・アクセストークンの更新。
 * - fetch は差し込める(テストで本物を呼ばない)。npm の新しい部品は使わない。
 * - ⚠秘密(client secret・refresh token・access token)は例外のメッセージやログに出さない。
 */
import crypto from "crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** 認可まわりの失敗。needsReconnect=管理画面で「Google に接続」をやり直してもらう種類。 */
export class DriveAuthError extends Error {
  readonly code: string;
  readonly needsReconnect: boolean;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DriveAuthError";
    this.code = code;
    this.needsReconnect = code === "invalid_grant" || code === "no_refresh_token" || code === "not_connected";
  }
}

export function buildConsentUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", DRIVE_SCOPE);
  // offline+consent: refresh token を必ずもらう(2回目以降の同意でも返るように)。
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", args.state);
  return u.toString();
}

const b64url = (b: Buffer) => b.toString("base64url");
function hmac(secret: string, data: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(data).digest());
}

/** state = `<nonce>.<発行時刻ms>.<署名>`。署名の材料に利用者 ID を含める(他人の state を使い回せない)。 */
export function signOauthState(args: { secret: string; userId: string; nowMs: number; nonce?: string }): string {
  const nonce = args.nonce ?? b64url(crypto.randomBytes(16));
  const ts = String(args.nowMs);
  const sig = hmac(args.secret, `${nonce}.${ts}.${args.userId}`);
  return `${nonce}.${ts}.${sig}`;
}

export function verifyOauthState(args: { secret: string; state: string; userId: string; nowMs: number }): boolean {
  const parts = args.state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(nonce) || !/^\d+$/.test(ts) || !/^[A-Za-z0-9_-]+$/.test(sig)) return false;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || args.nowMs - issued > OAUTH_STATE_TTL_MS || issued > args.nowMs + 60_000) return false;
  const expected = hmac(args.secret, `${nonce}.${ts}.${args.userId}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function postToken(form: URLSearchParams, fetchFn: typeof fetch): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  let json: TokenResponse = {};
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    json = {};
  }
  if (!res.ok) {
    // ⚠error_description は出さない(内容に秘密が混じることは無いが、形が定まらないので code だけ)。
    throw new DriveAuthError(json.error ?? `http_${res.status}`, "Google の認可サーバーが受け付けませんでした");
  }
  return json;
}

export async function exchangeAuthorizationCode(
  args: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresInSec: number }> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
  });
  const json = await postToken(form, fetchFn);
  if (!json.access_token) throw new DriveAuthError("no_access_token", "アクセストークンが返りませんでした");
  if (!json.refresh_token) {
    throw new DriveAuthError("no_refresh_token", "更新用のトークンが返りませんでした。もう一度「Google に接続」からやり直してください");
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSec: json.expires_in ?? 3600 };
}

export async function refreshAccessToken(
  args: { refreshToken: string; clientId: string; clientSecret: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  const json = await postToken(form, fetchFn);
  if (!json.access_token) throw new DriveAuthError("no_access_token", "アクセストークンが返りませんでした");
  return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 3600 };
}
