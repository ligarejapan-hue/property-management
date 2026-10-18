/**
 * セルフインの一覧から取った1行(collect.cjs の JSONL)を、名簿の行にする。DB を触らない純関数(設計 2026-10-18 §4)。
 * ⚠数字に直せない値は null(他の欄は入れる)。取った文字は raw にそのまま残す。
 */
import { areaKey, buildingNameKey } from "@/lib/building-identity";

export const CATALOG_SOURCE = "selfin";
/** 一都三県(東京・神奈川・埼玉・千葉)。 */
const PREF_CODES = new Set(["13", "14", "11", "12"]);

export interface CatalogRow {
  source: string;
  sourceId: string;
  name: string;
  address: string;
  prefCode: string;
  stations: string[];
  builtYear: number | null;
  builtMonth: number | null;
  totalFloors: number | null;
  basementFloors: number | null;
  totalUnits: number | null;
  structureType: string | null;
  developer: string | null;
  managementCompany: string | null;
  raw: Record<string, unknown>;
  nameKey: string | null;
  areaKey: string | null;
  fetchedAt: Date;
}

const nfkc = (s: string) => s.normalize("NFKC");

export function cleanText(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t === "" || t === "不明" ? null : t;
}

export function parseCompleted(s: string | null): { year: number; month: number | null } | null {
  if (!s) return null;
  const m = nfkc(s).match(/(\d{4})年(?:\s*(\d{1,2})月)?/);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) : null;
  return { year: Number(m[1]), month: month !== null && month >= 1 && month <= 12 ? month : null };
}

export function parseFloors(s: string | null): { above: number | null; below: number | null } {
  if (!s) return { above: null, below: null };
  const t = nfkc(s);
  const above = t.match(/地上\s*(\d+)\s*階/);
  const below = t.match(/地下\s*(\d+)\s*階/);
  const n = (m: RegExpMatchArray | null) => (m && Number(m[1]) > 0 ? Number(m[1]) : null);
  return { above: n(above), below: n(below) };
}

export function parseUnits(s: string | null): number | null {
  if (!s) return null;
  const m = nfkc(s).replace(/,/g, "").match(/(\d+)\s*戸/);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

export function toCatalogRow(line: string): CatalogRow | null {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const sourceId = typeof o.id === "string" && /^\d+$/.test(o.id) ? o.id : null;
  const name = cleanText(o.name);
  const address = cleanText(o.address);
  const prefCode = typeof o.pref === "string" && PREF_CODES.has(o.pref) ? o.pref : null;
  if (!sourceId || !name || !address || !prefCode) return null;
  const completed = parseCompleted(cleanText(o.completed));
  const floors = parseFloors(cleanText(o.floors));
  const fetched = typeof o.fetchedAt === "string" ? new Date(o.fetchedAt) : new Date(NaN);
  return {
    source: CATALOG_SOURCE,
    sourceId,
    name,
    address,
    prefCode,
    stations: Array.isArray(o.stations) ? o.stations.map(cleanText).filter((x): x is string => x !== null) : [],
    builtYear: completed?.year ?? null,
    builtMonth: completed?.month ?? null,
    totalFloors: floors.above,
    basementFloors: floors.below,
    totalUnits: parseUnits(cleanText(o.units)),
    structureType: cleanText(o.structure),
    developer: cleanText(o.developer),
    managementCompany: cleanText(o.manager),
    raw: o,
    nameKey: buildingNameKey(name),
    areaKey: areaKey(address),
    // 読めない時刻は「今」にしない(呼び出し側の時計に任せず、固定の値にする=テストが時計に依存しない)。
    fetchedAt: Number.isNaN(fetched.getTime()) ? new Date(0) : fetched,
  };
}
