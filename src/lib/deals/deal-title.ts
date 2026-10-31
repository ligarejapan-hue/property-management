import type { PropertySnapshot } from "./schemas";

/**
 * 取引の見出し(取引名の入力は廃止・発注者指定 2026-10-31)。
 * 建物名+部屋番号、なければ住所。物件が未入力なら保存済みの名前(今までの取引名/新しい取引は取引番号)。
 */
export function dealTitle(d: {
  name: string;
  propertySnapshot: Pick<PropertySnapshot, "buildingName" | "roomNo" | "address">;
}): string {
  const s = d.propertySnapshot;
  if (s.buildingName) return [s.buildingName, s.roomNo].filter(Boolean).join(" ");
  return s.address || d.name;
}
