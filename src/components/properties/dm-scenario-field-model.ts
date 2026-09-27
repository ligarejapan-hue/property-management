import { resolveScenario, type ScenarioRow } from "@/lib/sale-dm-letter/scenario-resolve";
import type { SaleDmScenarioOption } from "@/lib/api-client";

export const DM_SCENARIO_UNAVAILABLE_LABEL = "(使えなくなった種類)自動に戻してください";
export const DM_SCENARIO_AUTO_FALLBACK_LABEL = "自動(発送のときに選ぶ既定の種類)";

/**
 * 物件の「DMの種類」欄の表示(設計 2026-09-27 §3.6)。純関数。
 * - label: 欄に出す文字(値があればその名前/空欄なら自動で決まる種類)
 * - autoLabel: 「自動」の選択肢に出す文字(空欄にしたときに何が選ばれるか)
 * - unavailable: 物件の値が選択肢に無い(「使わない」にされた/削除された)
 * 選択肢は「使う」の種類だけ(options の口がそう返す)なので、ScenarioRow へは active=true で写す。
 */
export function dmScenarioFieldView(
  property: { dmScenarioId: string | null; introductionRoute: string | null },
  options: SaleDmScenarioOption[],
): { label: string; autoLabel: string; unavailable: boolean } {
  const scenarios: ScenarioRow[] = options.map((o) => ({ id: o.id, name: o.name, autoKey: o.autoKey, active: true, deletedAt: null }));
  const auto = resolveScenario({ propertyScenarioId: null, introductionRoute: property.introductionRoute, defaultScenarioId: null, scenarios });
  const autoName = auto.ok && auto.via === "auto" ? scenarios.find((s) => s.id === auto.scenarioId)?.name : undefined;
  const autoLabel = autoName ? `自動: ${autoName}` : DM_SCENARIO_AUTO_FALLBACK_LABEL;

  if (!property.dmScenarioId) return { label: autoLabel, autoLabel, unavailable: false };
  const own = options.find((o) => o.id === property.dmScenarioId);
  if (!own) return { label: DM_SCENARIO_UNAVAILABLE_LABEL, autoLabel, unavailable: true };
  return { label: own.name, autoLabel, unavailable: false };
}
