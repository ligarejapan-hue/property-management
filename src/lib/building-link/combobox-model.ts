/** 物件名の候補つき入力欄の判断(設計 §6.1)。React に依存しない。 */
import { buildingNameKey } from "@/lib/building-identity";
import type { BuildingChoice } from "./resolve";
import { SUGGEST_MIN_KEY_LENGTH, type BuildingSuggestion } from "./suggest";

export function shouldFetchSuggestions(name: string): boolean {
  return (buildingNameKey(name) ?? "").length >= SUGGEST_MIN_KEY_LENGTH;
}
export function isLatestRequest(seq: number, latest: number): boolean {
  return seq === latest;
}
export function nextActiveIndex(current: number, key: "ArrowDown" | "ArrowUp", optionCount: number): number {
  if (optionCount <= 0) return -1;
  if (key === "ArrowDown") return current + 1 >= optionCount ? 0 : current + 1;
  return current - 1 < 0 ? optionCount - 1 : current - 1;
}
export function suggestionBadges(s: BuildingSuggestion): string[] {
  if (!s.sameName) return [];
  return s.sameArea ? ["同じ名前"] : ["同じ名前", "丁目が違います"];
}
export function choiceSummary(choice: BuildingChoice, selected: BuildingSuggestion | null): string | null {
  if (choice.kind === "new") return "新しい棟として登録します";
  if (choice.kind === "existing" && selected) {
    return `棟「${selected.name}」(${selected.area || "住所不明"}・${selected.unitCount}部屋)につなぎます`;
  }
  return null;
}
