import { z } from "zod";
import { DEFAULT_PROPERTY_KINDS, type BasePropertyKind, type PropertyKindDef } from "./constants";
import type { BusinessVariant } from "./business-schema";

/**
 * 事業計画書のセクション(依頼書 4.2)。rule は表より先に効く決まり:
 * all=全件 / bank=銀行向けだけ / oc=OC ありだけ。表(種別×セクション)は「出してよいか」だけを持つ(計画の読み替え 2)。
 */
export const BUSINESS_SECTIONS = [
  { key: "overview", label: "物件概要", rule: "all" },
  { key: "purchase", label: "仕入", rule: "all" },
  { key: "acquisition", label: "取得経費", rule: "all" },
  { key: "renovation", label: "改装・工事", rule: "all" },
  { key: "holding", label: "保有コスト", rule: "all" },
  { key: "sale", label: "販売", rule: "all" },
  { key: "profit", label: "収支", rule: "all" },
  { key: "financing", label: "資金計画", rule: "bank" },
  { key: "oc", label: "OC収支", rule: "oc" },
  { key: "evidence", label: "販売価格の根拠", rule: "bank" },
] as const;
export type BusinessSectionKey = (typeof BUSINESS_SECTIONS)[number]["key"];
const SECTION_KEYS = BUSINESS_SECTIONS.map((s) => s.key) as [BusinessSectionKey, ...BusinessSectionKey[]];
export const SECTION_RULE_LABELS = { all: "全件", bank: "銀行向けだけ", oc: "OC ありだけ" } as const;

export type SectionRow = Record<BusinessSectionKey, boolean>;
/** 種別の鍵 → セクション → 出してよいか。 */
export type SectionMatrix = Record<string, SectionRow>;

/** 保存する形。種別の鍵は物件種別と同じ書き方。 */
export const sectionMatrixSchema = z.record(z.string().regex(/^[a-z0-9_]{1,30}$/), z.partialRecord(z.enum(SECTION_KEYS), z.boolean()));

const allOn = (): SectionRow => Object.fromEntries(SECTION_KEYS.map((k) => [k, true])) as SectionRow;
/** 初期の表: 全部オン。土地は改装・工事をオフ。 */
const DEFAULT_ROWS: Record<BasePropertyKind, SectionRow> = {
  unit: allOn(), house: allOn(), building: allOn(), land: { ...allOn(), renovation: false },
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** 保存した行を、もとの行に重ねる(真偽でない値は無視)。 */
function overlay(base: SectionRow, raw: unknown): SectionRow {
  const r = obj(raw);
  const out = { ...base };
  for (const k of SECTION_KEYS) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  return out;
}

/**
 * 設定の表を、物件種別ごとの全セクションの行にそろえる。欠けは初期値で補う。
 * 足した種別は、自分の行が無い項目を元の種別の行(保存した値を含む)で補う。
 */
export function resolveSectionMatrix(raw: unknown, kinds: PropertyKindDef[]): SectionMatrix {
  const saved = obj(raw);
  const list = kinds.length ? kinds : DEFAULT_PROPERTY_KINDS;
  const out: SectionMatrix = {};
  const baseRow = (b: BasePropertyKind) => overlay(DEFAULT_ROWS[b], saved[b]);
  for (const k of list) out[k.key] = k.key === k.base ? baseRow(k.base) : overlay(baseRow(k.base), saved[k.key]);
  return out;
}

/** その取引で出すセクション(並びは BUSINESS_SECTIONS のとおり)。知らない種別は全部オンの行で決める。 */
export function businessPlanSections(
  kindKey: string | null, kinds: PropertyKindDef[], hasOc: boolean, variant: BusinessVariant, matrix: SectionMatrix,
): BusinessSectionKey[] {
  const known = kindKey ? (kinds.length ? kinds : DEFAULT_PROPERTY_KINDS).some((k) => k.key === kindKey) : false;
  const row = known && kindKey ? (matrix[kindKey] ?? allOn()) : allOn();
  return BUSINESS_SECTIONS.filter((s) => {
    if (s.rule === "bank" && variant !== "bank") return false;
    if (s.rule === "oc" && !hasOc) return false;
    return row[s.key];
  }).map((s) => s.key);
}
