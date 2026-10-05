/**
 * 写真(dm_lp_assets)が「使用中」か=LP型の枠(dm_lp_variant_media)・削除されていない台帳の枠
 * (dm_scenario_media)・削除されていない台帳の手紙のイラスト・発送の型の手紙のイラストのどれかから
 * 参照されているか(設計 2026-09-27 §3.1・2026-10-05 §4)。
 * ⚠写真の削除は論理削除なので FK の RESTRICT では守れない。数える場所は必ずこのファイルを通す
 *   (削除・公開口・一覧・LPの写真画面の4か所。走査テストで固定)。
 */
import type { PrismaClient } from "@/generated/prisma";

// 手紙のイラスト(設計 2026-10-05): 台帳(削除されていないもの)と、発送の型が参照していれば使用中。
export const ASSET_REFERENCE_COUNT_SELECT = {
  _count: {
    select: {
      media: true,
      scenarioMedia: { where: { scenario: { deletedAt: null } } },
      scenarioLetterIllustrations: { where: { deletedAt: null } },
      variantIllustrations: true,
    },
  },
} as const;

export function isAssetReferenced(row: {
  _count: { media: number; scenarioMedia: number; scenarioLetterIllustrations?: number; variantIllustrations?: number };
}): boolean {
  const c = row._count;
  return c.media > 0 || c.scenarioMedia > 0 || (c.scenarioLetterIllustrations ?? 0) > 0 || (c.variantIllustrations ?? 0) > 0;
}

export async function countAssetReferences(
  tx: Pick<PrismaClient, "dmLpVariantMedia" | "dmScenarioMedia" | "dmScenario" | "dmVariant">,
  assetId: string,
): Promise<number> {
  const [a, b, c, d] = await Promise.all([
    tx.dmLpVariantMedia.count({ where: { assetId } }),
    tx.dmScenarioMedia.count({ where: { assetId, scenario: { deletedAt: null } } }),
    tx.dmScenario.count({ where: { letterIllustrationAssetId: assetId, deletedAt: null } }),
    tx.dmVariant.count({ where: { illustrationAssetId: assetId } }),
  ]);
  return a + b + c + d;
}
