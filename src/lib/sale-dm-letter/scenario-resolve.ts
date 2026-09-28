/**
 * 宛先の「DMの種類」を決める純関数(設計 2026-09-27 §3.2)。DB を読まない。
 * 順: 物件の欄 → 導入ルート(自動) → 発送の既定。どの段でも「使わない」「削除済み」は返さない。
 * 物件の欄が指す id が一覧に無いときは、自動・既定に落とさず止める(黙って別の種類にしない)。
 * ⚠呼び出し側は、台帳の行と物件の行をロックした後に読んだ値を渡すこと(§3.3 の 2・3)。
 */

export type ScenarioRow = { id: string; name: string; autoKey: string | null; active: boolean; deletedAt: Date | null };
export type ResolveInput = { propertyScenarioId: string | null; introductionRoute: string | null; defaultScenarioId: string | null; scenarios: ScenarioRow[] };
export type ResolveResult =
  | { ok: true; scenarioId: string; via: "property" | "auto" | "default" }
  | { ok: false; reason: "no_default" | "property_scenario_missing" };

export const AUTO_KEY_BY_ROUTE: Readonly<Record<string, string>> = Object.freeze({
  reception_csv: "inheritance",
  field_survey: "vacant",
});

export function isUsableScenario(s: ScenarioRow | undefined): boolean {
  return !!s && s.active && s.deletedAt === null;
}

export function resolveScenario(input: ResolveInput): ResolveResult {
  const byId = new Map(input.scenarios.map((s) => [s.id, s]));
  if (input.propertyScenarioId) {
    const own = byId.get(input.propertyScenarioId);
    if (!own) return { ok: false, reason: "property_scenario_missing" };
    if (isUsableScenario(own)) return { ok: true, scenarioId: own.id, via: "property" };
  }
  const autoKey = input.introductionRoute ? AUTO_KEY_BY_ROUTE[input.introductionRoute] : undefined;
  if (autoKey) {
    const auto = input.scenarios.find((s) => s.autoKey === autoKey);
    if (isUsableScenario(auto)) return { ok: true, scenarioId: auto!.id, via: "auto" };
  }
  if (input.defaultScenarioId) {
    const def = byId.get(input.defaultScenarioId);
    if (isUsableScenario(def)) return { ok: true, scenarioId: def!.id, via: "default" };
  }
  return { ok: false, reason: "no_default" };
}
