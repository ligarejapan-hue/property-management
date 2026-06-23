import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { isCorporateLookupConfigured } from "@/lib/corporate-lookup";
import { isRegistryAutoFetchProviderConfigured } from "@/lib/registry-fetch/auto-fetch";
import { isRegistryOcrConfigured } from "@/lib/registry-ocr/client";
import { isSaleDmConfigured } from "@/lib/sale-dm-letter";

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
      // scanned 謄本の OCR 下書き生成が「この利用者に」使えるか。
      // OCR サービス設定済み（localhost allowlist 通過）かつ admin のときだけ true。
      registryOcrDraft:
        isRegistryOcrConfigured() && session.role === "admin",
      // 売却促進DM の文面生成 provider が設定済みか（boolean のみ）。
      // 未設定なら一覧の「売却DMを作成」導線を出さない（押すと 503 になるのを防ぐ）。
      saleDmLetter: isSaleDmConfigured(),
    };
    return apiResponse({ permissions, capabilities });
  } catch (error) {
    return handleApiError(error);
  }
}
