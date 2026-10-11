/**
 * 物件の基本情報の「物件名」から棟につなぐ確認の判断(React に依存しない)。
 * 発注者の指示(2026-10-11): 物件名を棟へのリンクに・棟が無ければ新しく作る・
 * 押したら確認を出す・似た名前の棟があれば確認の中で選ばせる。
 */
import type { BuildingChoice } from "./resolve";
import { allowsNewBuilding, shouldFetchSuggestions, type SuggestListState } from "./combobox-model";
import type { BuildingSuggestion } from "./suggest";

/**
 * 確認を開いたときに選んでおくもの。
 * 同じ町丁目・同じ名前の棟があればそれ、無ければ新しい棟。
 * ⚠一覧を全部確かめられていない(partial・読み込み中・失敗)ときは「新しい棟」を選んでおかない
 *   (同じ名前の棟を見落としたまま新しく作るのを防ぐ・入力欄の候補と同じ決まり)。
 * ⚠partial は「自動の判断」(auto)を選んでおく(@codex P2)。候補が0件だと選べるものが無く
 *   行き止まりになるため。auto はサーバーが保存の中で全部の棟を確かめて、同じ町丁目の同じ名前の
 *   棟へつなぎ、無ければ作る(見落としによる重複は起きない)。
 * ⚠ただし住所から町丁目が読めない物件(area が空)は auto も選ばない(@codex P2)。サーバーは
 *   町丁目が分からないと探さずに新しく作る(area_unknown)ため、候補に出なかった同じ建物の棟と重複する。
 *   その場合は候補から選ぶか、物件の住所を直してもらう。
 */
export function initialLinkChoice(
  suggestions: BuildingSuggestion[],
  state: SuggestListState,
  area: string,
): BuildingChoice | null {
  if (state !== "ready" && state !== "partial") return null;
  const same = suggestions.find((x) => x.sameName && x.sameArea);
  if (same) return { kind: "existing", buildingId: same.id };
  if (allowsNewBuilding(state)) return { kind: "new" };
  return allowsAutoLink(state, area) ? { kind: "auto" } : null;
}

/**
 * 物件名が短くて候補を探せないときの選び方(@codex P2)。町丁目が分かれば自動の判断(auto)、
 * 読めなければ選ばない(サーバーは町丁目が分からないと探さずに新しく作るため、重複する)。
 */
export function shortNameLinkChoice(area: string): BuildingChoice | null {
  return area !== "" ? { kind: "auto" } : null;
}

/** 「自動で判断してつなぐ」を出せるか: 候補を全部出せなかった(partial)・町丁目が分かるときだけ。 */
export function allowsAutoLink(state: SuggestListState, area: string): boolean {
  return state === "partial" && area !== "";
}

/**
 * 候補を探せる物件名か(@codex P2)。比べる形が短い(1文字)と候補の問い合わせは何も探さずに空を返す。
 * ⚠その空を「全部確かめた」と読むと「新しい棟」を選んでおき、同じ名前の棟があっても新しく作ってしまう。
 *   探せない名前は候補を出さず、自動の判断(同じ町丁目の同じ名前の棟へ・無ければ作る)に任せる。
 */
export function linkNeedsSuggestions(buildingName: string): boolean {
  return shouldFetchSuggestions(buildingName);
}

/** 確定ボタンの文言。 */
export function linkConfirmButtonLabel(choice: BuildingChoice | null): string {
  if (choice?.kind === "existing") return "この棟につなぐ";
  if (choice?.kind === "new") return "新しい棟を作ってつなぐ";
  return "つなぐ";
}

/**
 * 基本情報の物件名の出し方。
 * - link: 棟につながっている → 棟の画面へのリンク
 * - connect: 棟につながっていない区分マンションで、編集できる → つなぐ確認を開く
 * - text: それ以外(見るだけの人・ほかの人が編集中・区分マンション以外・物件名が空)
 */
export function buildingNameLinkMode(p: {
  propertyType: string;
  buildingName: string | null;
  building: { id: string } | null;
  canWrite: boolean;
  lockedByOther: boolean;
}): "link" | "connect" | "text" {
  if (p.building) return "link";
  if (p.propertyType !== "apartment_unit") return "text";
  if (!p.buildingName || p.buildingName.trim() === "") return "text";
  if (!p.canWrite || p.lockedByOther) return "text";
  return "connect";
}
