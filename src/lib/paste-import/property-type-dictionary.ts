/**
 * 物件種別の言い換え → PropertyType。
 * ⚠知らない種別は unknown + confident=false にして、確認画面で人に決めてもらう。
 *   推測で決めると、間違った種別のまま登録される。
 */
export type MappedPropertyType =
  | "land" | "house" | "apartment_unit" | "apartment_building"
  | "store" | "office" | "unknown";

/**
 * 部分一致で判定する。**順序が意味を持つ**: 長い語を先に置く。
 * 「一棟マンション」が「マンション」より前にないと apartment_unit になってしまう。
 */
const RULES: { needle: string; value: MappedPropertyType }[] = [
  { needle: "一棟マンション", value: "apartment_building" },
  { needle: "一棟アパート", value: "apartment_building" },
  { needle: "区分所有", value: "apartment_unit" },
  { needle: "分譲マンション", value: "apartment_unit" },
  { needle: "マンション", value: "apartment_unit" },
  { needle: "一戸建", value: "house" },
  { needle: "戸建", value: "house" },
  { needle: "一般住宅", value: "house" },
  { needle: "住宅", value: "house" },
  { needle: "土地", value: "land" },
  { needle: "更地", value: "land" },
  { needle: "店舗", value: "store" },
  { needle: "事務所", value: "office" },
];

export function propertyTypeForRaw(raw: string): {
  value: MappedPropertyType;
  confident: boolean;
} {
  const s = raw.replace(/[\s　]/g, "");
  if (s === "") return { value: "unknown", confident: false };
  for (const rule of RULES) {
    if (s.includes(rule.needle)) return { value: rule.value, confident: true };
  }
  return { value: "unknown", confident: false };
}
