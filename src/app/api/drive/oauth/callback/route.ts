import type { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { redirectToDriveAdmin, requireDriveAdmin } from "@/lib/drive/admin-access";
import { getDriveClientConfig, getDriveRedirectUri, getOauthStateSecret } from "@/lib/drive/config";
import { DriveAuthError, exchangeAuthorizationCode, verifyOauthState } from "@/lib/drive/oauth";
import { DriveClient } from "@/lib/drive/client";
import { saveDriveConnection } from "@/lib/drive/connection";
import { isSecretCryptoConfigured } from "@/lib/sale-dm-letter/secret-crypto";

/**
 * GET /api/drive/oauth/callback — Google の同意画面からの戻り。
 * - state は「この利用者が10分以内に始めた」ものだけ通す(CSRF 対策)。
 * - コードを refresh token に替え、暗号化して保存。アカウントのメールは Drive の about から。
 * - 失敗はすべて管理画面へ戻して理由の種類だけを出す(コード・トークンは URL にもログにも残さない)。
 */
export async function GET(request: NextRequest) {
  try {
    const session = await requireDriveAdmin();
    const sp = request.nextUrl.searchParams;
    if (sp.get("error")) return redirectToDriveAdmin({ error: "denied" });
    const code = sp.get("code") ?? "";
    const state = sp.get("state") ?? "";
    const secret = getOauthStateSecret();
    if (!secret || !verifyOauthState({ secret, state, userId: session.id, nowMs: Date.now() })) {
      return redirectToDriveAdmin({ error: "state" });
    }
    if (code === "") return redirectToDriveAdmin({ error: "no_code" });
    const cfg = getDriveClientConfig();
    const redirectUri = getDriveRedirectUri();
    if (!cfg || !redirectUri) return redirectToDriveAdmin({ error: "not_configured" });
    if (!isSecretCryptoConfigured()) return redirectToDriveAdmin({ error: "crypto" });

    const tokens = await exchangeAuthorizationCode({ code, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri });
    const about = await new DriveClient(tokens.accessToken).about();
    await saveDriveConnection({ accountEmail: about.emailAddress, refreshToken: tokens.refreshToken, userId: session.id });
    // ⚠監査にはメールもトークンも書かない(接続した事実だけ)。
    await writeAuditLog({ userId: session.id, action: "drive_connect", targetTable: "drive_connection" });
    return redirectToDriveAdmin({ connected: "1" });
  } catch (e) {
    if (e instanceof DriveAuthError) return redirectToDriveAdmin({ error: e.code === "no_refresh_token" ? "no_refresh_token" : "exchange" });
    return handleApiError(e);
  }
}
