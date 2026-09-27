import { describe, it, expect } from "vitest";
import { resolveScenario, AUTO_KEY_BY_ROUTE } from "@/lib/sale-dm-letter/scenario-resolve";
import { INTRODUCTION_ROUTE_VALUES } from "@/lib/property-types";

const S = (id: string, autoKey: string | null, active = true, deleted = false) =>
  ({ id, name: id, autoKey, active, deletedAt: deleted ? new Date() : null });

describe("resolveScenario(設計 §3.2)", () => {
  const inh = S("inh", "inheritance"), vac = S("vac", "vacant"), area = S("area", null);

  it("物件の欄が有効ならそれが最優先", () => {
    expect(resolveScenario({ propertyScenarioId: "area", introductionRoute: "reception_csv", defaultScenarioId: "vac", scenarios: [inh, vac, area] }))
      .toEqual({ ok: true, scenarioId: "area", via: "property" });
  });
  it("導入ルート8種すべて: 受付帳取込=相続・現地調査=空き家・他は既定", () => {
    for (const route of [...INTRODUCTION_ROUTE_VALUES, null]) {
      const r = resolveScenario({ propertyScenarioId: null, introductionRoute: route, defaultScenarioId: "area", scenarios: [inh, vac, area] });
      const expected = route === "reception_csv" ? { ok: true, scenarioId: "inh", via: "auto" }
        : route === "field_survey" ? { ok: true, scenarioId: "vac", via: "auto" }
        : { ok: true, scenarioId: "area", via: "default" };
      expect(r, String(route)).toEqual(expected);
    }
  });
  it("「使わない」「削除済み」はどの段でも返さない", () => {
    for (const bad of [S("inh", "inheritance", false), S("inh", "inheritance", true, true)]) {
      const r = resolveScenario({ propertyScenarioId: "inh", introductionRoute: "reception_csv", defaultScenarioId: "vac", scenarios: [bad, vac] });
      expect(r).toEqual({ ok: true, scenarioId: "vac", via: "default" });
    }
  });
  it("物件の欄が指す id が一覧に無い=黙って落とさず止める", () => {
    expect(resolveScenario({ propertyScenarioId: "ghost", introductionRoute: "reception_csv", defaultScenarioId: "vac", scenarios: [inh, vac] }))
      .toEqual({ ok: false, reason: "property_scenario_missing" });
  });
  it("既定が無い/無効で他の段でも決まらない=no_default", () => {
    expect(resolveScenario({ propertyScenarioId: null, introductionRoute: "other", defaultScenarioId: null, scenarios: [inh, vac] }))
      .toEqual({ ok: false, reason: "no_default" });
    expect(resolveScenario({ propertyScenarioId: null, introductionRoute: "other", defaultScenarioId: "x", scenarios: [inh, vac, S("x", null, false)] }))
      .toEqual({ ok: false, reason: "no_default" });
  });
  it("自動の対応表は2つだけ", () => {
    expect(AUTO_KEY_BY_ROUTE).toEqual({ reception_csv: "inheritance", field_survey: "vacant" });
  });
});
