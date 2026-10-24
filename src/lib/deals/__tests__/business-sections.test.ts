import { describe, expect, it } from "vitest";
import {
  BUSINESS_SECTIONS, businessPlanSections, resolveSectionMatrix, sectionMatrixSchema, type BusinessSectionKey,
} from "../business-sections";
import { DEFAULT_PROPERTY_KINDS, type PropertyKindDef } from "../constants";

const KINDS: PropertyKindDef[] = [...DEFAULT_PROPERTY_KINDS, { key: "shop_unit", label: "店舗区分", base: "unit" }];
const ALL = BUSINESS_SECTIONS.map((s) => s.key);
const without = (...ks: BusinessSectionKey[]) => ALL.filter((k) => !ks.includes(k));

describe("事業計画書のセクション(依頼書 4.2)", () => {
  it("並びは依頼書の表のとおり", () => {
    expect(ALL).toEqual(["overview", "purchase", "acquisition", "renovation", "holding", "sale", "profit", "financing", "oc", "evidence"]);
  });
  it("初期の表: 全部オン・土地だけ改装・工事がオフ", () => {
    const m = resolveSectionMatrix(undefined, KINDS);
    expect(Object.values(m.unit).every(Boolean)).toBe(true);
    expect(m.land.renovation).toBe(false);
    expect(m.land.overview).toBe(true);
  });
  it("銀行向けだけ: 資金計画・販売価格の根拠/OC ありだけ: OC収支(表より決まりが先)", () => {
    const m = resolveSectionMatrix(undefined, KINDS);
    expect(businessPlanSections("unit", KINDS, false, "internal", m)).toEqual(without("financing", "oc", "evidence"));
    expect(businessPlanSections("unit", KINDS, false, "bank", m)).toEqual(without("oc"));
    expect(businessPlanSections("unit", KINDS, true, "bank", m)).toEqual(ALL);
    expect(businessPlanSections("land", KINDS, true, "internal", m)).toEqual(without("renovation", "financing", "evidence"));
  });
  it("表でオフにしたセクションは出さない・保存した表の欠けは初期値で補う", () => {
    const m = resolveSectionMatrix({ unit: { holding: false }, house: { renovation: false, evidence: false } }, KINDS);
    expect(businessPlanSections("unit", KINDS, false, "internal", m)).not.toContain("holding");
    expect(m.unit.overview).toBe(true);
    expect(businessPlanSections("house", KINDS, false, "bank", m)).toEqual(without("renovation", "oc", "evidence"));
  });
  it("足した種別は、自分の行が無ければ元の種別の行を使う・知らない種別は全部オンの初期値", () => {
    const m = resolveSectionMatrix({ unit: { holding: false } }, KINDS);
    expect(m.shop_unit.holding).toBe(false);
    const own = resolveSectionMatrix({ unit: { holding: false }, shop_unit: { holding: true } }, KINDS);
    expect(own.shop_unit.holding).toBe(true);
    expect(businessPlanSections("castle", KINDS, false, "internal", m)).toEqual(without("financing", "oc", "evidence"));
    expect(businessPlanSections(null, KINDS, false, "internal", m)).toEqual(without("financing", "oc", "evidence"));
  });
  it("壊れた表は初期値として扱う", () => {
    expect(resolveSectionMatrix("x", KINDS).land.renovation).toBe(false);
    expect(resolveSectionMatrix({ unit: { holding: "no" } }, KINDS).unit.holding).toBe(true);
  });
  it("保存: 種別の鍵 × 知っているセクション × オン/オフだけ", () => {
    expect(sectionMatrixSchema.safeParse({ unit: { holding: false } }).success).toBe(true);
    expect(sectionMatrixSchema.safeParse({ unit: { secret: false } }).success).toBe(false);
    expect(sectionMatrixSchema.safeParse({ "Bad Key": { holding: false } }).success).toBe(false);
    expect(sectionMatrixSchema.safeParse({ unit: { holding: 1 } }).success).toBe(false);
  });
});
