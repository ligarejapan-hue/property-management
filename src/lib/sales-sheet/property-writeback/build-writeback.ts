import type { SalesSheetTemplateKind } from "../template-kind";
import * as M from "../option-master";
import { parseNumeric, parseBuiltYearMonth, pickOption } from "./parse-values";
import { fitsDecimalScale } from "@/lib/decimal-scale";

export type WritebackCurrent = {
  property: Record<string, unknown>;
  building: Record<string, unknown> | null;
};
export type WritebackResult = {
  property: Record<string, string | number | null>;
  building: Record<string, string | number | null>;
  unreadable: string[];
  /**
   * 入力されたが**保存先が無い**項目([@codex P2])。
   * 区分マンションの築年月・地下階は棟の列へ入るため、棟に紐づいていない部屋
   * (物件名だけ持つ区分)では入れても行き先が無い。黙って捨てると、作成後の知らせが
   * 「保存した」とも「読めなかった」とも言わないまま値だけ消える。
   */
  noTarget: string[];
  /**
   * 物件の欄に入る文字数を超えた項目(交通・間取り・向き)。読めなかったのではなく
   * 長すぎるだけなので、知らせの文を `unreadable` と分ける(図面にはそのまま載る)。
   */
  tooLong: string[];
};

/**
 * 数値列の範囲/整数制約(仕様書 §6.1・I-1: 制約を満たさない値もその欄だけ保存しない)。
 * scale は DECIMAL(p,s) の s。[@codex P2] 桁数を見ないと DB 側が黙って丸め、図面・
 * 変更履歴・物件の値が食い違ったまま残る。
 */
type NumberRange = { min: number; max: number; int?: boolean; scale?: number };

/**
 * 整数列の範囲。src/lib/validators.ts の updatePropertySchema と同じ値
 * (F3 で足した16列に既に入っている範囲)を使う。
 */
const INT_RANGES = {
  floorNo: { min: -10, max: 200, int: true },
  managementFee: { min: 0, max: 10000000, int: true },
  repairReserveFee: { min: 0, max: 10000000, int: true },
  aboveFloors: { min: 0, max: 200, int: true },
  basementFloors: { min: 0, max: 20, int: true },
  totalUnits: { min: 0, max: 9999, int: true },
} as const satisfies Record<string, NumberRange>;
/** 小数列の範囲と桁数(同上・validators.ts / schema.prisma と同じ値)。 */
// [@codex P2] 上限は列が実際に入れられる最大値に合わせる(DECIMAL(p,s) は整数部 p-s 桁 +
// 小数 s 桁)。整数部だけで切ると、DB は受け付ける値を画面が「範囲外」と言うことになる。
const DECIMAL_RANGES = {
  salePrice: { min: 0, max: 99999999999.9, scale: 1 }, // DECIMAL(12,1)
  saleTaxAmount: { min: 0, max: 99999999999.9, scale: 1 }, // DECIMAL(12,1)
  expectedIncome: { min: 0, max: 99999999999.9, scale: 1 }, // DECIMAL(12,1)
  landArea: { min: 0, max: 99999999.99, scale: 2 }, // DECIMAL(10,2)
  totalFloorArea: { min: 0, max: 99999999.99, scale: 2 }, // DECIMAL(10,2)
  exclusiveArea: { min: 0, max: 999999.99, scale: 2 }, // DECIMAL(8,2)
  balconyArea: { min: 0, max: 999999.99, scale: 2 }, // DECIMAL(8,2)
  grossYield: { min: 0, max: 999.99, scale: 2 }, // DECIMAL(5,2)
} as const satisfies Record<string, NumberRange>;
/** 築年の範囲(validators.ts の builtYear と同じ値)。月は parse-values.ts が既に1〜12へ限定済み。 */
const BUILT_YEAR_RANGE: NumberRange = { min: 1800, max: 2200 };

function inRange(n: number, range?: NumberRange): boolean {
  if (!range) return true;
  if (n < range.min || n > range.max) return false;
  if (range.int && !Number.isInteger(n)) return false;
  if (range.scale !== undefined && !fitsDecimalScale(n, range.scale)) return false;
  return true;
}

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
  /**
   * `to: "building"` の規則で、**棟に紐づいていないとき**に代わりに保存する物件の列。
   * 本番の区分は全件が棟に紐づいていないため(2026-09-27 実測)、棟の項目を物件の欄に
   * 持たせる(unit-building-facts.ts と同じ判断)。無ければ従来どおり noTarget。
   */
  propertyColumnWhenNoBuilding?: string;
  /** 読み取り方 */
  as: "number" | "text" | { option: readonly string[] };
  /** as:"number" のときの範囲/整数制約(無ければ制約なし)。 */
  range?: NumberRange;
  /**
   * as:"text" のときの文字数上限(無ければ制限なし)。
   * ⚠[@codex P2] 図面側の入力上限と物件列の上限は別物で、図面のほうが緩い項目がある
   * (交通=図面500 / 物件200)。上限を見ずに保存すると、**物件編集画面の検証(200)を
   * 通らない値が列に入り、以後その物件を普通の編集画面から保存できなくなる**。
   * 勝手に切り詰めず、範囲外の数値と同じく「読めなかった欄」として報告する。
   */
  maxLength?: number;
};

/**
 * text として保存する列の文字数上限。src/lib/validators.ts の updatePropertySchema と
 * 同じ値を使う(option 判定の列は候補側で長さが決まるため対象外)。
 */
const TEXT_MAX_LENGTHS = {
  access: 200,
  layoutType: 50,
  orientation: 50,
} as const;

const PRICE = (opts: readonly string[]): Rule[] => [
  { key: "price", label: "価格", to: "property", column: "salePrice", as: "number", range: DECIMAL_RANGES.salePrice },
  { key: "tax", label: "消費税", to: "property", column: "saleTaxType", as: { option: opts } },
  { key: "taxAmount", label: "うち消費税", to: "property", column: "saleTaxAmount", as: "number", range: DECIMAL_RANGES.saleTaxAmount },
];
const ACCESS: Rule = { key: "access", label: "交通", to: "property", column: "access", as: "text", maxLength: TEXT_MAX_LENGTHS.access };
const LAND: Rule[] = [
  { key: "landArea", label: "土地面積", to: "property", column: "landArea", as: "number", range: DECIMAL_RANGES.landArea },
  { key: "areaMethod", label: "面積計測方式", to: "property", column: "landAreaMethod", as: { option: M.AREA_METHOD_LAND } },
];

/** 築年月は1項目から2列(年・月)へ入るため、規則表とは別に扱う。 */
const BUILT_LABEL = "築年月";

const RULES: Record<SalesSheetTemplateKind, Rule[]> = {
  land: [
    { key: "price", label: "価格", to: "property", column: "salePrice", as: "number", range: DECIMAL_RANGES.salePrice },
    ACCESS,
    ...LAND,
  ],
  mansion: [
    ...PRICE(M.TAX),
    ACCESS,
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_MANSION } },
    { key: "exclusiveArea", label: "専有面積", to: "property", column: "exclusiveArea", as: "number", range: DECIMAL_RANGES.exclusiveArea },
    { key: "balconyArea", label: "バルコニー面積", to: "property", column: "balconyArea", as: "number", range: DECIMAL_RANGES.balconyArea },
    { key: "layout", label: "間取り", to: "property", column: "layoutType", as: "text", maxLength: TEXT_MAX_LENGTHS.layoutType },
    { key: "balconyDir", label: "バルコニー向き", to: "property", column: "orientation", as: "text", maxLength: TEXT_MAX_LENGTHS.orientation },
    { key: "floorNo", label: "所在階", to: "property", column: "floorNo", as: "number", range: INT_RANGES.floorNo },
    { key: "managementFee", label: "管理費", to: "property", column: "managementFee", as: "number", range: INT_RANGES.managementFee },
    { key: "repairFee", label: "修繕積立金", to: "property", column: "repairReserveFee", as: "number", range: INT_RANGES.repairReserveFee },
    // ⚠区分の構造・地上階・総戸数は**棟の値が正**で、図面からは変えない(作成画面でも表示だけ)。
    //   棟へ書き戻す規則を置かない(以前は入力経路から到達しない規則が残っていた。後で
    //   入力経路にキーを足すと同じ棟の全部屋へ黙って書き込むことになるため消した)。
    { key: "basementFloors", label: "地下階", to: "building", column: "basementFloors", propertyColumnWhenNoBuilding: "basementFloors", as: "number", range: INT_RANGES.basementFloors },
  ],
  house: [
    ...PRICE(M.TAX),
    ACCESS,
    ...LAND,
    { key: "buildingArea", label: "建物面積", to: "property", column: "totalFloorArea", as: "number", range: DECIMAL_RANGES.totalFloorArea },
    { key: "structure", label: "建物構造", to: "property", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "aboveFloors", label: "地上階", to: "property", column: "aboveFloors", as: "number", range: INT_RANGES.aboveFloors },
    { key: "basementFloors", label: "地下階", to: "property", column: "basementFloors", as: "number", range: INT_RANGES.basementFloors },
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_HOUSE } },
  ],
  building: [
    ...PRICE(M.TAX),
    ACCESS,
    ...LAND,
    { key: "totalFloorArea", label: "延床面積", to: "property", column: "totalFloorArea", as: "number", range: DECIMAL_RANGES.totalFloorArea },
    { key: "structure", label: "構造", to: "property", column: "structureType", as: { option: M.BUILDING_STRUCTURE } },
    { key: "aboveFloors", label: "地上階", to: "property", column: "aboveFloors", as: "number", range: INT_RANGES.aboveFloors },
    { key: "basementFloors", label: "地下階", to: "property", column: "basementFloors", as: "number", range: INT_RANGES.basementFloors },
    { key: "parking", label: "駐車場", to: "property", column: "parking", as: { option: M.PARKING_HOUSE } },
    { key: "totalUnits", label: "総戸数", to: "property", column: "totalUnits", as: "number", range: INT_RANGES.totalUnits },
    { key: "grossYield", label: "想定利回り", to: "property", column: "grossYield", as: "number", range: DECIMAL_RANGES.grossYield },
    { key: "expectedIncome", label: "満室想定収入", to: "property", column: "expectedIncome", as: "number", range: DECIMAL_RANGES.expectedIncome },
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
  const out: WritebackResult = { property: {}, building: {}, unreadable: [], noTarget: [], tooLong: [] };
  const hasBuilding = current.building !== null;

  for (const rule of RULES[kind]) {
    const raw = values[rule.key];
    if (typeof raw !== "string" || raw.trim() === "") continue; // 空は変更なし
    // 棟に紐づいていない区分は、棟の項目を物件の欄へ(代わりの列があるときだけ)。
    const to: "property" | "building" =
      rule.to === "building" && !hasBuilding && rule.propertyColumnWhenNoBuilding ? "property" : rule.to;
    const column =
      to === "property" && rule.to === "building" ? rule.propertyColumnWhenNoBuilding! : rule.column;
    if (to === "building" && !hasBuilding) {
      out.noTarget.push(rule.label); // 棟に紐づいていない＝入れても行き先が無い
      continue;
    }

    let next: string | number | null;
    if (rule.as === "number") {
      const n = parseNumeric(raw);
      next = n !== null && inRange(n, rule.range) ? n : null;
    } else if (rule.as === "text") {
      const t = raw.trim();
      // 上限超過は切り詰めずに保存しない。勝手に短くすると、図面に出ている文と
      // 物件に入った文が食い違ったまま気づけない。読めなかったのではないので
      // 知らせは `tooLong` で分ける。
      if (rule.maxLength !== undefined && t.length > rule.maxLength) {
        out.tooLong.push(rule.label);
        continue;
      }
      next = t;
    }
    else next = pickOption(raw, rule.as.option);

    if (next === null) {
      out.unreadable.push(rule.label);
      continue;
    }
    const currentBag = to === "property" ? current.property : (current.building ?? {});
    if (same(currentBag[column], next)) continue;
    const bag = to === "property" ? out.property : out.building;
    bag[column] = next;
  }

  // 築年月(1項目 → 年・月の2列)
  // 区分の築年月は棟へ。ただし棟に紐づいていなければ物件の欄へ(地下階と同じ判断)。
  const builtTarget =
    BUILT_TARGET[kind] === "building" && !hasBuilding ? "property" : BUILT_TARGET[kind];
  const builtRaw = values.builtYearMonth;
  if (builtTarget && typeof builtRaw === "string" && builtRaw.trim() !== "") {
    const parsed = parseBuiltYearMonth(builtRaw);
    if (parsed === null || !inRange(parsed.year, BUILT_YEAR_RANGE)) {
      out.unreadable.push(BUILT_LABEL);
    } else {
      const currentBag = builtTarget === "property" ? current.property : (current.building ?? {});
      const bag = builtTarget === "property" ? out.property : out.building;
      if (!same(currentBag.builtYear, parsed.year)) bag.builtYear = parsed.year;
      if (parsed.month !== null) {
        if (!same(currentBag.builtMonth, parsed.month)) bag.builtMonth = parsed.month;
      } else if (currentBag.builtMonth !== null && currentBag.builtMonth !== undefined) {
        // [@codex P2] 「2020年」と年だけ書き直したのに前の月が残ると、図面は「2020年」
        // なのに物件は「2020年3月」になり、次に作る図面へ勝手に月が復活する。
        // 入れ直した内容に合わせて月も消す。
        bag.builtMonth = null;
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
    // 棟の項目を物件の欄へ保存した場合(棟に紐づいていない区分)も「保存した」に数える。
    const inProperty =
      rule.propertyColumnWhenNoBuilding !== undefined && rule.propertyColumnWhenNoBuilding in result.property;
    if (rule.column in bag || inProperty) out.push(rule.label);
  }
  const builtIn = (bag: WritebackResult["property"]) => "builtYear" in bag || "builtMonth" in bag;
  if (builtIn(result.property) || builtIn(result.building)) out.push(BUILT_LABEL);
  return out;
}
