import { loadDealRegistryRights } from "./registry-rights-load";
import { registryDocInfo } from "./registry-rights";

/** 書類確認書に使う形(名前なし)。読み取りが壊れても書類は出す=判定できない扱い(計画の読み替え 5)。 */
export async function loadRegistryDocInfo(propertyId: string | null): Promise<{ activeRights: number; caution: string | null }> {
  try {
    return registryDocInfo(await loadDealRegistryRights(propertyId));
  } catch {
    return registryDocInfo({ status: "unreadable" });
  }
}
