/**
 * 「種類つきの発送」と組の決まり(設計 2026-09-27 §3.3.0・§3.4)。純関数・DB を読まない。
 * 種類つき = default_scenario_id が入っている発送(作成時に一度だけ立ち、後から変わらない)。
 * 組の決まり: 手紙の型の scenarioId=S なら、LP は「その発送で S から写した LP の型」、無ければ NULL。
 */
export type PairVariant = { id: string; scenarioId: string | null };

export function isScenarioCampaign(c: { defaultScenarioId: string | null }): boolean {
  return c.defaultScenarioId !== null;
}

/** 種類つきの発送で、手紙の型 letter に対して期待される LP の型 id(無ければ null)。 */
export function expectedLpVariantId(letter: PairVariant, lpVariants: PairVariant[]): string | null {
  if (letter.scenarioId === null) return null;
  return lpVariants.find((l) => l.scenarioId === letter.scenarioId)?.id ?? null;
}

/** 組の決まり(spec §3.3.0)。種類なしの発送では常に true。 */
export function isValidScenarioPair(
  campaign: { defaultScenarioId: string | null },
  letter: PairVariant,
  lpVariantId: string | null,
  lpVariants: PairVariant[],
): boolean {
  if (!isScenarioCampaign(campaign)) return true;
  if (letter.scenarioId === null) return false;
  return lpVariantId === expectedLpVariantId(letter, lpVariants);
}
