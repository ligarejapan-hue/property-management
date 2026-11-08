/**
 * 「謄本の名義の確認」に要る権限(ピュア・2026-11-08 発注者決定)。
 *
 * - 見る: 物件を見る + 所有者を見る + 氏名を伏せずに見られる + 謄本を見られる
 *   (一覧と並べて出すのは氏名=伏せ字では比べられない・謄本の中身を読むので謄本の閲覧も要る)
 * - 「このままでよい」: 見る + 所有者を編集できる(発注者決定=所有者を編集できる人まで)
 * - 「謄本の名義に直す」: 見る + **管理者だけ**(発注者決定)。所有者を物件から外す操作
 *   (`/api/properties/[id]/owners/[ownerId]` DELETE)と同じ線=管理者の代わりの鍵
 *   user_management:read + property:write。足す側は謄本からの所有者反映と同じ
 *   import:write + owner:write(氏名・住所の項目ごとの権限は反映の共通処理が見る)。
 * - 全件を比べる(謄本をまとめて読む): 見る + 管理者だけ(他人の担当物件もまとめて読む)
 */
import type { PermissionEntry } from "@/lib/api-helpers";
import { getOwnerFieldLevel, hasPermission, isMaskFreeLevel } from "@/lib/permissions";

export type RegistryOwnerReviewAction = "view" | "keep" | "replace" | "run";

export function findMissingRegistryOwnerReviewPerm(
  perms: PermissionEntry[],
  action: RegistryOwnerReviewAction,
): string | null {
  if (!hasPermission(perms, "property", "read")) return "物件を見る権限がありません";
  if (!hasPermission(perms, "owner", "read")) return "所有者を見る権限がありません";
  if (!isMaskFreeLevel(getOwnerFieldLevel(perms, "owner_name"))) {
    return "所有者の氏名を見る権限がありません";
  }
  if (!hasPermission(perms, "registry_pdf", "preview")) return "謄本を見る権限がありません";
  if (action === "view") return null;
  if (action === "keep") {
    return hasPermission(perms, "owner", "write") ? null : "所有者を編集する権限がありません";
  }
  // replace / run は管理者だけ
  if (!hasPermission(perms, "user_management", "read")) return "この操作は管理者だけができます";
  if (action === "run") return null;
  if (!hasPermission(perms, "property", "write")) return "物件を編集する権限がありません";
  if (!hasPermission(perms, "import", "write")) return "取込の権限がありません";
  if (!hasPermission(perms, "owner", "write")) return "所有者を編集する権限がありません";
  return null;
}
