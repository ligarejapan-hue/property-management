/**
 * 宛先の「DMの種類」を決める純関数(設計 2026-09-27 §3.2)。DB を読まない。
 * 順: 物件の欄 → 導入ルート×物件種別(自動) → 導入ルート(自動) → 発送の既定。どの段でも「使わない」「削除済み」は返さない。
 * 物件の欄が指す id が一覧に無いときは、自動・既定に落とさず止める(黙って別の種類にしない)。
 * ⚠呼び出し側は、台帳の行と物件の行をロックした後に読んだ値を渡すこと(§3.3 の 2・3)。
 */

export type ScenarioRow = { id: string; name: string; autoKey: string | null; active: boolean; deletedAt: Date | null };
export type ResolveInput = {
  propertyScenarioId: string | null;
  introductionRoute: string | null;
  /** 物件種別(PropertyType の値)。導入ルートの自動を種別でさらに分けるときに使う。 */
  propertyType: string | null;
  defaultScenarioId: string | null;
  scenarios: ScenarioRow[];
};
export type ResolveResult =
  | { ok: true; scenarioId: string; via: "property" | "auto" | "default" }
  | { ok: false; reason: "no_default" | "property_scenario_missing" };

export const AUTO_KEY_BY_ROUTE: Readonly<Record<string, string>> = Object.freeze({
  reception_csv: "inheritance",
  field_survey: "vacant",
});

/**
 * 導入ルート×物件種別で分ける自動(2026-10-15)。相続した家の売却の特例(売却益から最大3,000万円)は
 * 区分マンションでは使えないので、受付帳取込の区分マンション(旧値 unit を含む)には特例に触れない手紙を出す。
 * この種類が「使わない」「削除済み」「台帳に無い」ときは導入ルートの自動(相続)に戻す(発注者判断 2026-10-15)。
 */
export const AUTO_KEY_BY_ROUTE_AND_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  reception_csv: Object.freeze({ apartment_unit: "inheritance_unit", unit: "inheritance_unit" }),
});

export function isUsableScenario(s: ScenarioRow | undefined): boolean {
  return !!s && s.active && s.deletedAt === null;
}

function autoKeysFor(introductionRoute: string | null, propertyType: string | null): string[] {
  if (!introductionRoute) return [];
  const keys: string[] = [];
  const byType = propertyType ? AUTO_KEY_BY_ROUTE_AND_TYPE[introductionRoute]?.[propertyType] : undefined;
  if (byType) keys.push(byType);
  const byRoute = AUTO_KEY_BY_ROUTE[introductionRoute];
  if (byRoute) keys.push(byRoute);
  return keys;
}

export function resolveScenario(input: ResolveInput): ResolveResult {
  const byId = new Map(input.scenarios.map((s) => [s.id, s]));
  if (input.propertyScenarioId) {
    const own = byId.get(input.propertyScenarioId);
    if (!own) return { ok: false, reason: "property_scenario_missing" };
    if (isUsableScenario(own)) return { ok: true, scenarioId: own.id, via: "property" };
  }
  for (const autoKey of autoKeysFor(input.introductionRoute, input.propertyType)) {
    const auto = input.scenarios.find((s) => s.autoKey === autoKey);
    if (isUsableScenario(auto)) return { ok: true, scenarioId: auto!.id, via: "auto" };
  }
  if (input.defaultScenarioId) {
    const def = byId.get(input.defaultScenarioId);
    if (isUsableScenario(def)) return { ok: true, scenarioId: def!.id, via: "default" };
  }
  return { ok: false, reason: "no_default" };
}
