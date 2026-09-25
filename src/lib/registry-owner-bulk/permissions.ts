/**
 * まとめて反映に必要な権限の判定（ピュア）。
 *
 * 1件ずつのボタン(`/api/properties/[id]/registry-owners`)と同じ線に、
 * **管理者のみ**を足したもの:
 *   - 役割が管理者(他人の担当物件もまとめて触るため)
 *   - 取込の権限 (import:write)
 *   - 所有者の編集権限 (owner:write)
 *   - 氏名・住所の**項目ごとの**書き込み権限 (owner_name / owner_address の full か edit)
 *
 * ⚠住所の項目権限は、まとめて反映では**無条件で必須**。1件ずつは「その謄本に住所が
 *   あるときだけ」求めるが、まとめて反映は中身を見る前に走り出すため、途中で住所つきの
 *   謄本に当たって半分だけ失敗する状態を避ける。
 * ⚠ここは**route とワーカーの両方**が使う。route を通したあとに権限を外された場合でも、
 *   ワーカーが処理を始める前にもう一度ここで止める。
 */
import type { PermissionEntry } from "@/lib/api-helpers";
import { hasExplicitWritePerm, hasPermission } from "@/lib/permissions";

/** 足りない権限の名前。すべて揃っていれば null。 */
export type MissingRegistryOwnerApplyPerm =
  | "role"
  | "import"
  | "owner"
  | "owner_name"
  | "owner_address";

export function findMissingRegistryOwnerApplyPerm(
  role: string,
  permissions: PermissionEntry[],
): MissingRegistryOwnerApplyPerm | null {
  if (role !== "admin") return "role";
  if (!hasPermission(permissions, "import", "write")) return "import";
  if (!hasPermission(permissions, "owner", "write")) return "owner";
  if (!hasExplicitWritePerm(permissions, "owner_name")) return "owner_name";
  if (!hasExplicitWritePerm(permissions, "owner_address")) return "owner_address";
  return null;
}

/** 画面・APIで使う日本語の理由。 */
export const REGISTRY_OWNER_APPLY_PERM_MESSAGES: Record<
  MissingRegistryOwnerApplyPerm,
  string
> = {
  role: "この操作は管理者のみ実行できます",
  import: "取込の権限がありません",
  owner: "所有者を編集する権限がありません",
  owner_name: "所有者の氏名を書き込む権限がありません",
  owner_address: "所有者の住所を書き込む権限がありません",
};
