/**
 * 物件のレコード単位アクセス判定。
 *
 * 物件詳細 API (GET /api/properties/[id]) と同じ field_staff スコープを
 * 別ルートでも適用するための共通ヘルパー。
 *
 * - admin / office_staff（field_staff 以外）: 全物件閲覧可
 * - field_staff: createdBy === session.id または assignedTo === session.id のみ
 *
 * 物件詳細 API のスコープ条件を変更する場合は、ここも同時に更新すること。
 * 個別物件 API と挙動がズレると、所有者メモ等の関連経路で PII（物件住所）が
 * 漏れる可能性がある。
 */
export interface PropertyAccessRecord {
  createdBy: string;
  assignedTo: string | null;
}

/**
 * **担当分しか見られない役割**か(現状 field_staff だけ)。
 *
 * ⚠この判定を各所にベタ書きしない。役割が増えたときに片方だけ直り、
 * 「認可は絞れているのに画面の写真では全部見えている」のような穴になる
 * (@codex #394 R2 P1 の実例: マイページの写真には**口座全体**の履歴が写る)。
 */
export function isPropertyScopedRole(role: string): boolean {
  return role === "field_staff";
}

export function canAccessPropertyRecord(
  session: { id: string; role: string },
  property: PropertyAccessRecord,
): boolean {
  if (!isPropertyScopedRole(session.role)) return true;
  return (
    property.createdBy === session.id || property.assignedTo === session.id
  );
}
