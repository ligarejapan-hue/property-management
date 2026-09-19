import type { SalesSheetTemplateKind } from "../template-kind";
import * as M from "../option-master";
import { parseNumeric, parseBuiltYearMonth, pickOption } from "./parse-values";

export type WritebackCurrent = {
  property: Record<string, unknown>;
  building: Record<string, unknown> | null;
};
export type WritebackResult = {
  property: Record<string, string | number | null>;
  building: Record<string, string | number | null>;
  unreadable: string[];
};

/** 図面の項目1つを、どこの列へどう読み取って保存するかの定義。 */
type Rule = {
  /** 図面の項目(field-model の key) */
  key: string;
  /** 画面に出す日本語ラベル */
  label: string;
  /** 保存先 */
  to: "property" | "building";
  /** 列名 */
  column: string;
  /** 読み取り方 */
  as: "number" | "text" | { option: readonly string[] };
};

const PRICE = (opts: readonly string[]): Rule[] => [
  { key: "price", label: "価格", to: "property", column: "salePrice", as: "number" },
  { key: "tax", label: "消費税", to: "property", column: "saleTaxType", as: { option: opts } },
  { key: "taxAmount", label: "うち消費税", to: "property", column: "saleTaxAmount", as: "number" },
];
const ACCESS: Rule = { key: "access", label: "交通", to: "property", column: "access", as: "text" };
const LAND: Rule[] = [
  { key: "landArea", label: "土地面積", to: "property", column: "landArea", as: "number" },
  { key: "areaMethod", label: "面積計測方式", to: "property", column: "landAreaMethod", as: { option: M.AREA_METHOD_LAND } },
];

/** 築年月は1項目から2列(年・月)へ入るため、規則表とは別に扱う。 */
const BUILT_LABEL = "築年月";

const RULES: Record<SalesSheetTemplateKind, Rule[]> = {
  land: [{ key: "price", label: "価格", to: "property", column: "salePrice", as: "number" }, ACCESS, ...LAND],
  mansion: [
    ...PRICE(M.TAX),
    ACCESS,
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_MANSION } },
    { key: "exclusiveArea", label: "専有面積", to: "property", column: "exclusiveArea", as: "number" },
    { key: "balconyArea", label: "バルコニー面積", to: "property", column: "balconyArea", as: "number" },
    { key: "layout", label: "間取り", to: "property", column: "layoutType", as: "text" },
    { key: "balconyDir", label: "バルコニー向き", to: "property", column: "orientation", as: "text" },
    { key: "floorNo", label: "所在階", to: "property", column: "floorNo", as: "number" },
    { key: "managementFee", label: "管理費", to: "property", column: "managementFee", as: "number" },
    { key: "repairFee", label: "修繕積立金", to: "property", column: "repairReserveFee", as: "number" },
    { key: "structure", label: "建物構造", to: "building", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "totalFloors", label: "地上階", to: "building", column: "totalFloors", as: "number" },
    { key: "basementFloors", label: "地下階", to: "building", column: "basementFloors", as: "number" },
    { key: "totalUnits", label: "総戸数", to: "building", column: "totalUnits", as: "number" },
  ],
  house: [
    ...PRICE(M.TAX),
    ACCESS,
    ...LAND,
    { key: "buildingArea", label: "建物面積", to: "property", column: "totalFloorArea", as: "number" },
    { key: "structure", label: "建物構造", to: "property", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "aboveFloors", label: "地上階", to: "property", column: "aboveFloors", as: "number" },
    { key: "basementFloors", label: "地下階", to: "property", column: "basementFloors", as: "number" },
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_HOUSE } },
  ],
  building: [
    ...PRICE(M.TAX),
    ACCESS,
    ...LAND,
    { key: "totalFloorArea", label: "延床面積", to: "property", column: "totalFloorArea", as: "number" },
    { key: "structure", label: "構造", to: "property", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "aboveFloors", label: "地上階", to: "property", column: "aboveFloors", as: "number" },
    { key: "basementFloors", label: "地下階", to: "property", column: "basementFloors", as: "number" },
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_HOUSE } },
    { key: "totalUnits", label: "総戸数", to: "property", column: "totalUnits", as: "number" },
    { key: "grossYield", label: "想定利回り", to: "property", column: "grossYield", as: "number" },
    { key: "expectedIncome", label: "満室想定収入", to: "property", column: "expectedIncome", as: "number" },
  ],
};

/** 築年月の保存先(区分だけ棟)。 */
const BUILT_TARGET: Record<SalesSheetTemplateKind, "property" | "building" | null> = {
  land: null,
  mansion: "building",
  house: "property",
  building: "property",
};

/** 今の値と同じなら保存しない(Decimal や Date は toString で比べる)。 */
function same(current: unknown, next: string | number): boolean {
  if (current === null || current === undefined) return false;
  return String(current) === String(next);
}

export function buildWriteback(input: {
  kind: SalesSheetTemplateKind;
  values: Record<string, string | undefined>;
  current: WritebackCurrent;
}): WritebackResult {
  const { kind, values, current } = input;
  const out: WritebackResult = { property: {}, building: {}, unreadable: [] };
  const hasBuilding = current.building !== null;

  for (const rule of RULES[kind]) {
    const raw = values[rule.key];
    if (typeof raw !== "string" || raw.trim() === "") continue; // 空は変更なし
    if (rule.to === "building" && !hasBuilding) continue;

    let next: string | number | null;
    if (rule.as === "number") next = parseNumeric(raw);
    else if (rule.as === "text") next = raw.trim();
    else next = pickOption(raw, rule.as.option);

    if (next === null) {
      out.unreadable.push(rule.label);
      continue;
    }
    const currentBag = rule.to === "property" ? current.property : (current.building ?? {});
    if (same(currentBag[rule.column], next)) continue;
    const bag = rule.to === "property" ? out.property : out.building;
    bag[rule.column] = next;
  }

  // 築年月(1項目 → 年・月の2列)
  const builtTarget = BUILT_TARGET[kind];
  const builtRaw = values.builtYearMonth;
  if (builtTarget && typeof builtRaw === "string" && builtRaw.trim() !== "") {
    if (builtTarget === "building" && !hasBuilding) {
      // 棟が無い区分は保存先が無いので何もしない
    } else {
      const parsed = parseBuiltYearMonth(builtRaw);
      if (parsed === null) {
        out.unreadable.push(BUILT_LABEL);
      } else {
        const currentBag = builtTarget === "property" ? current.property : (current.building ?? {});
        const bag = builtTarget === "property" ? out.property : out.building;
        if (!same(currentBag.builtYear, parsed.year)) bag.builtYear = parsed.year;
        if (parsed.month !== null && !same(currentBag.builtMonth, parsed.month)) {
          bag.builtMonth = parsed.month;
        }
      }
    }
  }

  return out;
}

/** 保存した列名 → 日本語ラベル(応答の `saved` に出す)。 */
export function labelsOf(kind: SalesSheetTemplateKind, result: WritebackResult): string[] {
  const out: string[] = [];
  for (const rule of RULES[kind]) {
    const bag = rule.to === "property" ? result.property : result.building;
    if (rule.column in bag) out.push(rule.label);
  }
  const builtBag = BUILT_TARGET[kind] === "building" ? result.building : result.property;
  if ("builtYear" in builtBag || "builtMonth" in builtBag) out.push(BUILT_LABEL);
  return out;
}
