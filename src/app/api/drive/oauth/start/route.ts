import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { redirectToDriveAdmin, requireDriveAdmin } from "@/lib/drive/admin-access";
import { getDriveClientConfig, getDriveRedirectUri, getOauthStateSecret } from "@/lib/drive/config";
import { buildConsentUrl, signOauthState } from "@/lib/drive/oauth";
import { isSecretCryptoConfigured } from "@/lib/sale-dm-letter/secret-crypto";

/**
 * GET /api/drive/oauth/start — 「Google に接続」。管理者のブラウザを Google の同意画面へ送る。
 * 設定が足りなければ管理画面へ戻して理由を出す(JSON は返さない=人が開く道)。
 */
export async function GET() {
  try {
    const session = await requireDriveAdmin();
    const cfg = getDriveClientConfig();
    const redirectUri = getDriveRedirectUri();
    const secret = getOauthStateSecret();
    if (!cfg) return redirectToDriveAdmin({ error: "not_configured" });
    if (!redirectUri) return redirectToDriveAdmin({ error: "no_redirect_uri" });
    if (!secret) return redirectToDriveAdmin({ error: "no_state_secret" });
    if (!isSecretCryptoConfigured()) return redirectToDriveAdmin({ error: "crypto" });
    const state = signOauthState({ secret, userId: session.id, nowMs: Date.now() });
    const url = buildConsentUrl({ clientId: cfg.clientId, redirectUri, state });
    return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (e) {
    return handleApiError(e);
  }
}
