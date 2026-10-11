/**
 * 物件の基本情報の「物件名」から棟につなぐ確認の判断(React に依存しない)。
 * 発注者の指示(2026-10-11): 物件名を棟へのリンクに・棟が無ければ新しく作る・
 * 押したら確認を出す・似た名前の棟があれば確認の中で選ばせる。
 */
import type { BuildingChoice } from "./resolve";
import { allowsNewBuilding, type SuggestListState } from "./combobox-model";
import type { BuildingSuggestion } from "./suggest";

/**
 * 確認を開いたときに選んでおくもの。
 * 同じ町丁目・同じ名前の棟があればそれ、無ければ新しい棟。
 * ⚠一覧を全部確かめられていない(partial・読み込み中・失敗)ときは「新しい棟」を選んでおかない
 *   (同じ名前の棟を見落としたまま新しく作るのを防ぐ・入力欄の候補と同じ決まり)。
 */
export function initialLinkChoice(
  suggestions: BuildingSuggestion[],
  state: SuggestListState,
): BuildingChoice | null {
  if (state !== "ready" && state !== "partial") return null;
  const same = suggestions.find((x) => x.sameName && x.sameArea);
  if (same) return { kind: "existing", buildingId: same.id };
  return allowsNewBuilding(state) ? { kind: "new" } : null;
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
