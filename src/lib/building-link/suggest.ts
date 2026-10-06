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
