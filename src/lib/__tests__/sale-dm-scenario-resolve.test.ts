import { describe, it, expect } from "vitest";
import { resolveScenario, AUTO_KEY_BY_ROUTE, AUTO_KEY_BY_ROUTE_AND_TYPE } from "@/lib/sale-dm-letter/scenario-resolve";
import { INTRODUCTION_ROUTE_VALUES, PROPERTY_TYPE_VALUES } from "@/lib/property-types";

const S = (id: string, autoKey: string | null, active = true, deleted = false) =>
  ({ id, name: id, autoKey, active, deletedAt: deleted ? new Date() : null });

describe("resolveScenario(設計 §3.2)", () => {
  const inh = S("inh", "inheritance"), vac = S("vac", "vacant"), area = S("area", null);

  it("物件の欄が有効ならそれが最優先", () => {
    expect(resolveScenario({ propertyScenarioId: "area", introductionRoute: "reception_csv", propertyType: null, defaultScenarioId: "vac", scenarios: [inh, vac, area] }))
      .toEqual({ ok: true, scenarioId: "area", via: "property" });
  });
  it("導入ルート8種すべて: 受付帳取込=相続・現地調査=空き家・他は既定", () => {
    for (const route of [...INTRODUCTION_ROUTE_VALUES, null]) {
      const r = resolveScenario({ propertyScenarioId: null, introductionRoute: route, propertyType: null, defaultScenarioId: "area", scenarios: [inh, vac, area] });
      const expected = route === "reception_csv" ? { ok: true, scenarioId: "inh", via: "auto" }
        : route === "field_survey" ? { ok: true, scenarioId: "vac", via: "auto" }
        : { ok: true, scenarioId: "area", via: "default" };
      expect(r, String(route)).toEqual(expected);
    }
  });
  it("「使わない」「削除済み」はどの段でも返さない", () => {
    for (const bad of [S("inh", "inheritance", false), S("inh", "inheritance", true, true)]) {
      const r = resolveScenario({ propertyScenarioId: "inh", introductionRoute: "reception_csv", propertyType: null, defaultScenarioId: "vac", scenarios: [bad, vac] });
      expect(r).toEqual({ ok: true, scenarioId: "vac", via: "default" });
    }
  });
  it("物件の欄が指す id が一覧に無い=黙って落とさず止める", () => {
    expect(resolveScenario({ propertyScenarioId: "ghost", introductionRoute: "reception_csv", propertyType: null, defaultScenarioId: "vac", scenarios: [inh, vac] }))
      .toEqual({ ok: false, reason: "property_scenario_missing" });
  });
  it("既定が無い/無効で他の段でも決まらない=no_default", () => {
    expect(resolveScenario({ propertyScenarioId: null, introductionRoute: "other", propertyType: null, defaultScenarioId: null, scenarios: [inh, vac] }))
      .toEqual({ ok: false, reason: "no_default" });
    expect(resolveScenario({ propertyScenarioId: null, introductionRoute: "other", propertyType: null, defaultScenarioId: "x", scenarios: [inh, vac, S("x", null, false)] }))
      .toEqual({ ok: false, reason: "no_default" });
  });
  it("自動の対応表は2つだけ", () => {
    expect(AUTO_KEY_BY_ROUTE).toEqual({ reception_csv: "inheritance", field_survey: "vacant" });
  });
});

describe("resolveScenario: 物件種別で分ける自動(2026-10-15 相続のマンション)", () => {
  const inh = S("inh", "inheritance"), unit = S("unit", "inheritance_unit"), vac = S("vac", "vacant"), area = S("area", null);
  const base = { propertyScenarioId: null, defaultScenarioId: "area" } as const;

  it("対応表は 受付帳取込×区分マンション(新旧の値)=相続(マンション) だけ", () => {
    expect(AUTO_KEY_BY_ROUTE_AND_TYPE).toEqual({ reception_csv: { apartment_unit: "inheritance_unit", unit: "inheritance_unit" } });
  });
  it("受付帳取込: 種別すべてを総当たり=区分マンションだけ相続(マンション)・他は相続", () => {
    for (const type of [...PROPERTY_TYPE_VALUES, null]) {
      const r = resolveScenario({ ...base, introductionRoute: "reception_csv", propertyType: type, scenarios: [inh, unit, vac, area] });
      const expected = type === "apartment_unit" || type === "unit" ? "unit" : "inh";
      expect(r, String(type)).toEqual({ ok: true, scenarioId: expected, via: "auto" });
    }
  });
  it("現地調査・その他の導入ルートは種別に関係なく今までどおり", () => {
    for (const route of [...INTRODUCTION_ROUTE_VALUES, null]) {
      if (route === "reception_csv") continue;
      for (const type of [...PROPERTY_TYPE_VALUES, null]) {
        const r = resolveScenario({ ...base, introductionRoute: route, propertyType: type, scenarios: [inh, unit, vac, area] });
        const expected = route === "field_survey" ? { ok: true, scenarioId: "vac", via: "auto" } : { ok: true, scenarioId: "area", via: "default" };
        expect(r, `${route}/${type}`).toEqual(expected);
      }
    }
  });
  it("相続(マンション)が「使わない」「削除済み」「台帳に無い」なら相続に戻す(発注者判断 2026-10-15)", () => {
    for (const scenarios of [[inh, S("unit", "inheritance_unit", false), area], [inh, S("unit", "inheritance_unit", true, true), area], [inh, area]]) {
      const r = resolveScenario({ ...base, introductionRoute: "reception_csv", propertyType: "apartment_unit", scenarios });
      expect(r).toEqual({ ok: true, scenarioId: "inh", via: "auto" });
    }
  });
  it("相続も相続(マンション)も使えなければ既定へ", () => {
    const r = resolveScenario({ ...base, introductionRoute: "reception_csv", propertyType: "apartment_unit", scenarios: [S("inh", "inheritance", false), S("unit", "inheritance_unit", false), area] });
    expect(r).toEqual({ ok: true, scenarioId: "area", via: "default" });
  });
  it("物件の欄で選んだ種類は種別より優先", () => {
    const r = resolveScenario({ ...base, propertyScenarioId: "inh", introductionRoute: "reception_csv", propertyType: "apartment_unit", scenarios: [inh, unit, area] });
    expect(r).toEqual({ ok: true, scenarioId: "inh", via: "property" });
  });
});
