/**
 * 写真(dm_lp_assets)が「使用中」か=LP型の枠(dm_lp_variant_media)か、削除されていない台帳の枠
 * (dm_scenario_media)から参照されているか(設計 2026-09-27 §3.1)。
 * ⚠写真の削除は論理削除なので FK の RESTRICT では守れない。数える場所は必ずこのファイルを通す
 *   (削除・公開口・一覧・LPの写真画面の4か所。走査テストで固定)。
 */
import type { PrismaClient } from "@/generated/prisma";

export const ASSET_REFERENCE_COUNT_SELECT = {
  _count: { select: { media: true, scenarioMedia: { where: { scenario: { deletedAt: null } } } } },
} as const;

export function isAssetReferenced(row: { _count: { media: number; scenarioMedia: number } }): boolean {
  return row._count.media > 0 || row._count.scenarioMedia > 0;
}

export async function countAssetReferences(
  tx: Pick<PrismaClient, "dmLpVariantMedia" | "dmScenarioMedia">,
  assetId: string,
): Promise<number> {
  const [a, b] = await Promise.all([
    tx.dmLpVariantMedia.count({ where: { assetId } }),
    tx.dmScenarioMedia.count({ where: { assetId, scenario: { deletedAt: null } } }),
  ]);
  return a + b;
}
