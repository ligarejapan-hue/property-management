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

export function canAccessPropertyRecord(
  session: { id: string; role: string },
  property: PropertyAccessRecord,
): boolean {
  if (session.role !== "field_staff") return true;
  return (
    property.createdBy === session.id || property.assignedTo === session.id
  );
}
