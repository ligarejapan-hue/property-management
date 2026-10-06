/** 物件名の候補つき入力欄の判断(設計 §6.1)。React に依存しない。 */
import { areaKey, buildingNameKey } from "@/lib/building-identity";
import type { BuildingChoice } from "./resolve";
import { SUGGEST_MIN_KEY_LENGTH, type BuildingSuggestion } from "./suggest";

export function shouldFetchSuggestions(name: string): boolean {
  return (buildingNameKey(name) ?? "").length >= SUGGEST_MIN_KEY_LENGTH;
}
/**
 * 候補の問い合わせの URL の検索部分。⚠住所はそのまま載せない(番地・部屋番号が
 * nginx 等の記録に残る)。サーバーが使うのは町丁目だけなので、ここで丸めて area で送る。
 */
export function suggestQueryString(name: string, address: string): string {
  return suggestQueryStringForArea(name, suggestArea(address));
}
/** 問い合わせに載せる町丁目(住所を丸めた値・分からなければ空)。 */
export function suggestArea(address: string): string {
  return areaKey(address) ?? "";
}
/** 丸め済みの町丁目で問い合わせの検索部分を作る。 */
export function suggestQueryStringForArea(name: string, area: string): string {
  return new URLSearchParams({ name, area }).toString();
}
/**
 * 手元の候補が「今の入力・今の町丁目」に対するものか(@codex R2)。
 * ⚠名前だけで見ると、住所を変えたあとも前の丁目で並べた候補が出たままになり、
 *   問い合わせが失敗するとずっと残る(違う棟を選べてしまう)。
 */
export function resultMatches(result: { query: string; area: string }, value: string, area: string): boolean {
  return result.query === value && result.area === area;
}
/** 候補の問い合わせの結果(どの名前・町丁目に対するものか+成否)。 */
export interface SuggestResult {
  query: string;
  area: string;
  status: "ok" | "error";
  data: BuildingSuggestion[];
}
export type SuggestListState = "loading" | "error" | "ready";
/**
 * 一覧に何を出すか(@codex R3)。⚠今の名前+町丁目の問い合わせが**成功で終わる**まで
 * 「新しい棟として登録する」を選べる一覧として出さない。遅い・失敗した問い合わせの間に
 * 「新しい棟」を選ぶと、同じ丁目に同じ名前の棟があっても新しく作ってしまう(重複)。
 */
export function listState(result: SuggestResult | null, value: string, area: string): SuggestListState {
  if (!result || !resultMatches(result, value, area)) return "loading";
  return result.status === "ok" ? "ready" : "error";
}
/** 上下キー・Enter で候補を動かす/選ぶのは ready のときだけ。 */
export function canUseListKeys(state: SuggestListState): boolean {
  return state === "ready";
}
/** 閉じた一覧(Esc・選んだ後)を上下キーで開き直すか。 */
export function shouldOpenOnArrow(e: { open: boolean; key: string; isComposing: boolean; value: string }): boolean {
  return !e.open && (e.key === "ArrowDown" || e.key === "ArrowUp") && !e.isComposing && shouldFetchSuggestions(e.value);
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

/** 強調中の行から選ぶ候補。範囲外(一覧が縮んだ等)は null=何も選ばない。一番下は「新しい棟」。 */
export function pickAtIndex(index: number, suggestions: BuildingSuggestion[]): BuildingSuggestion | "new" | null {
  if (!Number.isInteger(index) || index < 0 || index > suggestions.length) return null;
  return index === suggestions.length ? "new" : suggestions[index];
}
/** 日本語変換中のキー(Enter は変換の確定)は候補の操作として扱わない。 */
export function shouldHandleListKey(isComposing: boolean): boolean {
  return !isComposing;
}
