import {
  getApiSession,
  getUserPermissions,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { isCorporateLookupConfigured } from "@/lib/corporate-lookup";
import {
  isRegistryAutoFetchProviderConfigured,
  isRegistryLocationSearchConfigured,
} from "@/lib/registry-fetch/auto-fetch";
import { isRegistryOcrConfigured } from "@/lib/registry-ocr/client";
import { isSaleDmConfigured } from "@/lib/sale-dm-letter";
import { resolveTrackingBaseUrl, resolveLpUrl } from "@/lib/sale-dm-letter/tracking";
import { isSenderConfigured } from "@/lib/sale-dm-letter/sender";
import { loadSaleDmConfig } from "@/lib/sale-dm-letter/config-store";

// ---------- GET /api/me/permissions ----------
// 現在ログイン中のユーザーの権限一覧を返す。
// クライアント側での表示制御（例: 案件ステータスドロップダウン）に使う。
// capabilities は env 設定状況などの「サーバー側の機能フラグ」を含める。

export async function GET() {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    // 売却促進DM の設定は DB→env で解決(管理画面で設定された値を反映)。
    const saleDmCfg = await loadSaleDmConfig();
    const capabilities = {
      corporateLookup: isCorporateLookupConfigured(),
      // 謄本自動取得 provider が設定済みか（boolean のみ）。secret・設定値そのものは返さない。
      registryAutoFetch: isRegistryAutoFetchProviderConfigured(),
      // 所在検索（番号無し物件を所在で検索して取得）が使えるか。自動取得より厳しく、provider が
      // supportsLocationSearch を宣言している場合のみ true（未対応で「所在で検索」ボタンを出さない）。
      registryLocationSearch: isRegistryLocationSearchConfigured(),
      // scanned 謄本の OCR 下書き生成が「この利用者に」使えるか。
      // OCR サービス設定済み（localhost allowlist 通過）かつ admin のときだけ true。
      registryOcrDraft:
        isRegistryOcrConfigured() && session.role === "admin",
      // 売却促進DM を「作成して印刷できる」前提が揃っているか（boolean のみ）。AI provider 設定に加え、郵送QRに
      // 必須の絶対URL（SALE_DM_TRACKING_BASE_URL / SALE_DM_LP_URL）と差出人（SALE_DM_SENDER_NAME / CONTACT）も
      // 要求する。いずれか未設定だと campaign 作成が 503 になるため「売却DMを作成」導線自体を出さない（生成/印刷の
      // fail-closed と UI を揃え、押して 503 になるのを防ぐ）。
      saleDmLetter: isSaleDmConfigured(saleDmCfg) && !!resolveTrackingBaseUrl(saleDmCfg) && !!resolveLpUrl(saleDmCfg) && isSenderConfigured(saleDmCfg),
    };
    return apiResponse({ permissions, capabilities });
  } catch (error) {
    return handleApiError(error);
  }
}
