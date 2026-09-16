import type { SheetField } from "./field-model";
import { formatValue, type SheetValues } from "./sheet-rows";

/** 販売図面の種別(ビルダーと同じ4種)。 */
export type SheetKind = "mansion" | "land" | "house" | "building";
export interface SheetRow {
  label: string;
  value: string;
}
interface RowPart {
  key: string;
  /** 値の前に付ける語(例: "地上" → "地上2階")。 */
  prefix?: string;
}
export interface RowSpec {
  label: string;
  parts: readonly RowPart[];
}

const part = (key: string, prefix?: string): RowPart => (prefix ? { key, prefix } : { key });

/** 種別ごとの主要8行(この順・空でも行を残す)。仕様書 §4.3。 */
export const MAIN_ROW_SPECS: Record<SheetKind, readonly RowSpec[]> = {
  house: [
    { label: "交通", parts: [part("access")] },
    { label: "間取り", parts: [part("layout")] },
    { label: "土地面積", parts: [part("landArea")] },
    { label: "建物面積", parts: [part("buildingArea")] },
    { label: "築年月", parts: [part("builtYearMonth")] },
    { label: "構造・階数", parts: [part("structure"), part("aboveFloors", "地上")] },
    { label: "駐車場", parts: [part("parking")] },
    { label: "現況・引渡", parts: [part("occupancy"), part("delivery", "引渡 ")] },
  ],
  mansion: [
    { label: "交通", parts: [part("access")] },
    { label: "間取り", parts: [part("layout")] },
    { label: "専有面積", parts: [part("exclusiveArea")] },
    { label: "バルコニー", parts: [part("balconyArea"), part("balconyDir")] },
    { label: "築年月", parts: [part("builtYearMonth")] },
    { label: "所在階・階数", parts: [part("floorNo"), part("totalFloors", "地上")] },
    { label: "管理費・修繕積立金", parts: [part("managementFee", "管理費 "), part("repairFee", "修繕 ")] },
    { label: "現況・引渡", parts: [part("occupancy"), part("delivery", "引渡 ")] },
  ],
  building: [
    { label: "交通", parts: [part("access")] },
    { label: "想定利回り", parts: [part("grossYield")] },
    { label: "満室想定収入", parts: [part("expectedIncome")] },
    { label: "総戸数", parts: [part("totalUnits")] },
    { label: "土地面積", parts: [part("landArea")] },
    { label: "延床面積", parts: [part("totalFloorArea")] },
    { label: "築年月", parts: [part("builtYearMonth")] },
    { label: "構造・階数", parts: [part("structure"), part("aboveFloors", "地上")] },
  ],
  land: [
    { label: "交通", parts: [part("access")] },
    { label: "土地面積", parts: [part("landArea")] },
    { label: "坪単価", parts: [part("unitPrice")] },
    { label: "用途地域", parts: [part("useDistrict")] },
    { label: "建蔽率・容積率", parts: [part("coverageRatio"), part("floorRatio")] },
    { label: "接道", parts: [part("roadDirections"), part("roadKind"), part("roadWidth", "幅員")] },
    { label: "地目", parts: [part("landCategory")] },
    { label: "現況・引渡", parts: [part("occupancy"), part("delivery", "引渡 ")] },
  ],
};

/** 詳細表で1行にまとめる組。field-model の並びで最初に現れた項目の位置に出す。 */
export const DETAIL_GROUPS: readonly RowSpec[] = [
  { label: "建蔽率/容積率", parts: [part("coverageRatio"), part("floorRatio")] },
  { label: "接道", parts: [part("roadDirections"), part("roadKind"), part("roadWidth", "幅員")] },
  { label: "各階面積", parts: [part("floor1Area", "1階 "), part("floor2Area", "2階 "), part("floor3Area", "3階 ")] },
];

/** 詳細表に出さない項目(価格・物件種目・物件名は紙面の別の場所に出る)。 */
const DETAIL_EXCLUDED_KEYS: ReadonlySet<string> = new Set(["price", "propertyType", "buildingName"]);

function isShown(f: SheetField, values: SheetValues): boolean {
  if (f.controlOnly || f.section === "会社") return false;
  if (f.showWhen) {
    const ctrl = values[f.showWhen.field];
    if ((typeof ctrl === "string" ? ctrl : "") !== f.showWhen.equals) return false;
  }
  return true;
}

function joinParts(parts: readonly RowPart[], byKey: Map<string, SheetField>, values: SheetValues): string {
  return parts
    .map((p) => {
      const f = byKey.get(p.key);
      if (!f || !isShown(f, values)) return "";
      const v = formatValue(f, values[p.key]);
      return v ? `${p.prefix ?? ""}${v}` : "";
    })
    .filter(Boolean)
    .join(" / ");
}

/**
 * 表示項目を「主要8行」と「詳細行」に振り分ける純関数(仕様書 §4.3)。
 * - 主要: MAIN_ROW_SPECS の順。空でも行を残す(作成後に編集画面で埋められる)。
 * - 詳細: 主要・DETAIL_EXCLUDED_KEYS・会社・非表示を除き、field-model の順。空行は出さない。
 */
export function splitMainDetailRows(
  kind: SheetKind,
  fields: readonly SheetField[],
  values: SheetValues,
): { main: SheetRow[]; detail: SheetRow[] } {
  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  const specs = MAIN_ROW_SPECS[kind];
  const main = specs.map((s) => ({ label: s.label, value: joinParts(s.parts, byKey, values) }));
  const usedInMain = new Set(specs.flatMap((s) => s.parts.map((p) => p.key)));

  const groupOf = new Map<string, RowSpec>();
  for (const g of DETAIL_GROUPS) for (const p of g.parts) groupOf.set(p.key, g);
  const emittedGroups = new Set<RowSpec>();

  const detail: SheetRow[] = [];
  for (const f of fields) {
    if (usedInMain.has(f.key) || DETAIL_EXCLUDED_KEYS.has(f.key) || !isShown(f, values)) continue;
    const group = groupOf.get(f.key);
    if (group) {
      if (emittedGroups.has(group)) continue;
      emittedGroups.add(group);
      const value = joinParts(group.parts.filter((p) => !usedInMain.has(p.key)), byKey, values);
      if (value) detail.push({ label: group.label, value });
      continue;
    }
    const value = formatValue(f, values[f.key]);
    if (value) detail.push({ label: f.label, value });
  }
  return { main, detail };
}

/** 詳細行を左右2列に分ける(奇数は左が1行多い)。 */
export function splitDetailColumns(rows: SheetRow[]): { left: SheetRow[]; right: SheetRow[] } {
  const half = Math.ceil(rows.length / 2);
  return { left: rows.slice(0, half), right: rows.slice(half) };
}
