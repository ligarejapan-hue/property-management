/** 編集で物件名を変えたときの付け替えの確認(D4・設計 §6.3)。 */
import { buildingNameKey } from "@/lib/building-identity";
import { BUILDING_LINK_TARGET_TYPE, type BuildingChoice } from "./resolve";

export function relinkConfirmMessage(
  current: { id: string; name: string } | null,
  newName: string,
  choice: BuildingChoice,
): string | null {
  if (!current) return null;
  if (newName.trim() === "") return `棟「${current.name}」から外します。よろしいですか？`;
  if (choice.kind === "existing") {
    return choice.buildingId === current.id ? null : `棟「${current.name}」から付け替えます。よろしいですか？`;
  }
  if (choice.kind === "new") return `棟「${current.name}」から付け替えます。よろしいですか？`;
  return buildingNameKey(newName) === buildingNameKey(current.name)
    ? null
    : `棟「${current.name}」から付け替えます。よろしいですか？`;
}

/**
 * 編集で種別を区分マンション以外へ変えたときの、棟から外れる確認。
 * ⚠サーバーは区分マンション以外なら棟から外す(区分（旧）だけは今の棟を残す)=decideBuildingLink と同じ線引き。
 */
export function typeChangeUnlinkConfirmMessage(
  current: { id: string; name: string } | null,
  oldType: string,
  newType: string,
): string | null {
  if (!current || oldType === newType) return null;
  if (newType === BUILDING_LINK_TARGET_TYPE || newType === "unit") return null;
  return `種別を区分マンション以外にすると、棟「${current.name}」から外れます。よろしいですか？`;
}
