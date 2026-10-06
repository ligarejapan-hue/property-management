/** 編集で物件名を変えたときの付け替えの確認(D4・設計 §6.3)。 */
import { buildingNameKey } from "@/lib/building-identity";
import type { BuildingChoice } from "./resolve";

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
