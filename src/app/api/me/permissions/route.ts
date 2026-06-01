import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { isCorporateLookupConfigured } from "@/lib/corporate-lookup";
import { isRegistryAutoFetchProviderConfigured } from "@/lib/registry-fetch/auto-fetch";

// ---------- GET /api/me/permissions ----------
// 現在ログイン中のユーザーの権限一覧を返す。
// クライアント側での表示制御（例: 案件ステータスドロップダウン）に使う。
// capabilities は env 設定状況などの「サーバー側の機能フラグ」を含める。

export async function GET() {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    const capabilities = {
      corporateLookup: isCorporateLookupConfigured(),
      // 謄本自動取得 provider が設定済みか（boolean のみ）。secret・設定値そのものは返さない。
      registryAutoFetch: isRegistryAutoFetchProviderConfigured(),
    };
    return apiResponse({ permissions, capabilities });
  } catch (error) {
    return handleApiError(error);
  }
}
