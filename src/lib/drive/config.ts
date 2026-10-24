/**
 * Google ドライブ連携の設定(env)。
 * - GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET: Cloud Console のウェブ型 OAuth クライアント(発注者が app.env に置く)。
 * - 戻り先(redirect URI)はアプリの絶対 URL(NEXTAUTH_URL)+固定の道。Cloud Console に同じ文字列を登録する。
 * ⚠値を画面やログに出さない(ID は出してよい・シークレットは「設定済み/未設定」だけ)。
 */

export const DRIVE_OAUTH_CALLBACK_PATH = "/api/drive/oauth/callback";

export function getDriveClientConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** 戻り先の絶対 URL。NEXTAUTH_URL(アプリの入口)が https の絶対 URL でなければ null。 */
export function getDriveRedirectUri(): string | null {
  const base = process.env.DRIVE_OAUTH_BASE_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && u.hostname !== "localhost") return null;
    return `${u.origin}${DRIVE_OAUTH_CALLBACK_PATH}`;
  } catch {
    return null;
  }
}

/** state の署名に使う秘密(NEXTAUTH_SECRET)。無ければ null=接続できない。 */
export function getOauthStateSecret(): string | null {
  const s = process.env.NEXTAUTH_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}
