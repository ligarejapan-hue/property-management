/**
 * 編集中の鍵(edit lock)を取れるかどうかの権限判定。
 *
 * ⚠鍵を取れる条件は**閲覧権限も必須**(設計の制約):
 *   - 物件 = property:read かつ property:write かつ canAccessPropertyRecord(担当範囲)
 *   - 所有者 = owner:read かつ owner:write かつ項目の明示の書込権限が1つ以上
 * 読みを外すと、画面には編集ボタンが出ないのに窓口を直接呼べば鍵だけ取って
 * 他人を締め出せてしまう(自分では編集できないのに他人の編集を止められる状態)。
 */
import { ApiError, type PermissionEntry } from "@/lib/api-helpers";
import { hasExplicitWritePerm, hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";

/**
 * 所有者の編集画面で編集できる項目の権限。
 * ⚠`PATCH /api/owners/[id]` の `fieldWriteChecks`(src/app/api/owners/[id]/route.ts)の
 *   resource を重複除去したものと一致させる(controller決定・2026-09-18)。
 *   別名(currentZip→owner_zip、currentAddress→owner_address、
 *   companyRegistryNumber→owner_corporate_number)がある分は resource ベースで数えるので
 *   このリストには出てこない。
 * ⚠この一致は手作業(Task 9 時点で走査テストなし)。ドリフト検出は
 *   `src/lib/edit-lock/__tests__/owner-field-permission-drift-scan.test.ts` を参照
 *   (fieldWriteChecks の resource 集合と自動比較する)。export しているのはそのテストが
 *   実体を import して比較するため(型情報のためだけに文字列を二重に書かない)。
 */
export const OWNER_FIELD_RESOURCES = [
  "owner_name",
  "owner_name_kana",
  "owner_phone",
  "owner_zip",
  "owner_address",
  "owner_email",
  "owner_note",
  "owner_corporate_number",
] as const;

export function canWriteOwnerAnyField(perms: PermissionEntry[]): boolean {
  return OWNER_FIELD_RESOURCES.some((r) => hasExplicitWritePerm(perms, r));
}

/**
 * 所有者の鍵を取れるか。不可なら ApiError(403)。
 */
export function assertCanLockOwner(perms: PermissionEntry[]): void {
  if (
    !hasPermission(perms, "owner", "read") ||
    !hasPermission(perms, "owner", "write") ||
    !canWriteOwnerAnyField(perms)
  ) {
    throw new ApiError(403, "この所有者を編集する権限がありません", "FORBIDDEN");
  }
}

/**
 * 物件の鍵を取れるか。不可なら ApiError(403)。
 * ⚠読みと書きは管理画面で別々に付けられるため、読めない利用者が鍵だけ取り、
 *   応答で保持者の氏名まで受け取れてしまわないよう、両方を要求する。
 */
export function assertCanLockProperty(
  session: { id: string; role: string },
  perms: PermissionEntry[],
  property: { createdBy: string; assignedTo: string | null },
): void {
  if (
    !hasPermission(perms, "property", "read") ||
    !hasPermission(perms, "property", "write") ||
    !canAccessPropertyRecord(session, property)
  ) {
    throw new ApiError(403, "この物件を編集する権限がありません", "FORBIDDEN");
  }
}
