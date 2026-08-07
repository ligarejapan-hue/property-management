/**
 * 謄本 一括取得(PR-B・薄い版)の route 共通ガード。
 * 単発取得 route(properties/[id]/registry/auto-fetch)の認可・readiness と同型に揃える。
 */
import {
  getApiSession,
  getUserPermissions,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  getRegistryFetchProvider,
  isRegistryPurchaseConfigured,
} from "@/lib/registry-fetch/auto-fetch";
import { loadRegistryFetchCredentials } from "@/lib/registry-fetch/config-store";
import type { RegistryFetchProvider } from "@/lib/registry-fetch";

export interface BulkRouteSession {
  id: string;
  role: string;
}

/**
 * 認証 + 権限(registry:auto_fetch AND property:read)を確認して session を返す。
 * 単発取得 route と同じ二重の権限要求。
 */
export async function requireBulkSession(): Promise<BulkRouteSession> {
  const session = await getApiSession();
  const permissions = await getUserPermissions(session.id);
  if (!hasPermission(permissions, "registry", "auto_fetch")) {
    throw new ApiError(403, "謄本自動取得の権限がありません", "FORBIDDEN");
  }
  if (!hasPermission(permissions, "property", "read")) {
    throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
  }
  return { id: session.id, role: session.role };
}

/**
 * 有料取得の readiness(課金スイッチ AND 所在検索校正)を確認し、provider を返す。
 * 未達なら 501(本番の課金スイッチ休眠中はここで止まる=実サイトへ到達しない)。
 * ⚠スイッチだけで判定しない(isRegistryPurchaseConfigured で丸ごと再評価)。
 */
export async function requireBulkPurchaseProvider(): Promise<RegistryFetchProvider> {
  const credentials = await loadRegistryFetchCredentials();
  if (!isRegistryPurchaseConfigured({ credentials })) {
    throw new ApiError(
      501,
      "謄本の有料取得は現在利用できません",
      "REGISTRY_PURCHASE_NOT_ENABLED",
    );
  }
  const provider = getRegistryFetchProvider({ credentials });
  if (!provider) {
    throw new ApiError(
      501,
      "謄本自動取得プロバイダは未設定です",
      "REGISTRY_AUTO_FETCH_PROVIDER_NOT_CONFIGURED",
    );
  }
  return provider;
}
