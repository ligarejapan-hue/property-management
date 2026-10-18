/** 物件名の候補の並べ方(設計 2026-10-04 §5)。DB を触らない純関数。 */
import { areaKey, buildingNameKey } from "@/lib/building-identity";

export interface BuildingSuggestion {
  id: string; name: string; area: string; unitCount: number;
  sameName: boolean; sameArea: boolean;
}
export const SUGGEST_MIN_KEY_LENGTH = 2;
export const SUGGEST_LIMIT = 10;

export function rankBuildingSuggestions(
  rows: { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; unitCount: number; createdAt: Date }[],
  target: { nameKey: string; areaKey: string | null },
): BuildingSuggestion[] {
  const scored = rows.map((b) => {
    const nk = b.nameKey ?? buildingNameKey(b.name);
    const ak = b.areaKey ?? areaKey(b.address);
    const sameName = nk === target.nameKey;
    const sameArea = target.areaKey !== null && ak === target.areaKey;
    const rank = sameName && sameArea ? 0 : sameName ? 1 : 2;
    return { b, ak, sameName, sameArea, rank };
  });
  scored.sort(
    (x, y) => x.rank - y.rank || y.b.unitCount - x.b.unitCount || x.b.createdAt.getTime() - y.b.createdAt.getTime(),
  );
  return scored.slice(0, SUGGEST_LIMIT).map(({ b, ak, sameName, sameArea }) => ({
    id: b.id, name: b.name, area: ak ?? "", unitCount: b.unitCount, sameName, sameArea,
  }));
}

/** 名簿(mansion_catalog)の候補(設計 2026-10-18 §6.2)。⚠住所は町丁目まで。 */
export interface CatalogSuggestion {
  catalogId: string; name: string; area: string;
  builtYear: number | null; totalFloors: number | null; totalUnits: number | null;
  sameName: boolean; sameArea: boolean;
}
export const CATALOG_SUGGEST_LIMIT = 5;

export function rankCatalogSuggestions(
  rows: { id: string; name: string; address: string; nameKey: string | null; areaKey: string | null; builtYear: number | null; totalFloors: number | null; totalUnits: number | null }[],
  target: { nameKey: string; areaKey: string | null },
): CatalogSuggestion[] {
  const scored = rows.map((c) => {
    const nk = c.nameKey ?? buildingNameKey(c.name);
    const ak = c.areaKey ?? areaKey(c.address);
    const sameName = nk === target.nameKey;
    const sameArea = target.areaKey !== null && ak === target.areaKey;
    return { c, ak, sameName, sameArea, rank: sameName && sameArea ? 0 : sameName ? 1 : 2 };
  });
  scored.sort((x, y) => x.rank - y.rank || (y.c.totalUnits ?? 0) - (x.c.totalUnits ?? 0) || x.c.id.localeCompare(y.c.id));
  return scored.slice(0, CATALOG_SUGGEST_LIMIT).map(({ c, ak, sameName, sameArea }) => ({
    catalogId: c.id, name: c.name, area: ak ?? "", builtYear: c.builtYear, totalFloors: c.totalFloors, totalUnits: c.totalUnits, sameName, sameArea,
  }));
}

/** 古い棟(nameKey が null)を読む1回の件数と、全体の上限(@codex R5)。 */
export const LEGACY_PAGE_SIZE = 200;
export const LEGACY_MAX_ROWS = 2000;

/**
 * 古い棟(比較キーが入る前の行)を id 順に**全部**読む(@codex R5)。DB を直接は触らず、
 * findMany の代わりの関数(cursorId の次から take 件・id 昇順)を受け取る。
 * ⚠古い順の50件だけを見ると、枠の外にある同じ名前の古い棟を見落とし、画面が
 *   「新しい棟として登録する」を出してしまう(重複の棟を作りうる)。
 * ⚠上限(2000件)で止めたときは complete=false。画面は「新しい棟」を出さない。
 *   ちょうど上限で尽きたかは1件だけ先を読んで確かめる。
 */
export async function readAllLegacyBuildings<T extends { id: string }>(
  fetchPage: (args: { cursorId: string | null; take: number }) => Promise<T[]>,
  pageSize: number = LEGACY_PAGE_SIZE,
  maxRows: number = LEGACY_MAX_ROWS,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  let cursorId: string | null = null;
  while (rows.length < maxRows) {
    const take = Math.min(pageSize, maxRows - rows.length);
    const page = await fetchPage({ cursorId, take });
    rows.push(...page);
    if (page.length < take) return { rows, complete: true };
    cursorId = page[page.length - 1].id;
  }
  const more = await fetchPage({ cursorId, take: 1 });
  return { rows, complete: more.length === 0 };
}
