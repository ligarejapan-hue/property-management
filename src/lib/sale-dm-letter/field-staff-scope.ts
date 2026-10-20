/**
 * 現地担当(field_staff)の可視範囲(純関数・env/DB 非依存)。route-guard.ts から分離(2026-10-20)=
 * next-auth を読み込まずにテストできるようにするため。route-guard は同じ関数を re-export する。
 *
 * field_staff は現在の物件 record scope(作成 or 担当)の宛先のみ可視にする。物件が別担当へ
 * 再割当されたら、自分が作成したキャンペーンでもその宛先PII(氏名/住所/本文)を出さない。
 * 物件の無い行(広告用の公開ページからの申込=property が null)は field_staff には出さない。
 * 非 field_staff(admin/office)は全件。
 */
export function filterDraftsByFieldStaffScope<
  T extends { property: { createdBy: string | null; assignedTo: string | null } | null },
>(drafts: T[], session: { id: string; role?: string | null }): T[] {
  if (session.role !== "field_staff") return drafts;
  return drafts.filter(
    (d) => d.property !== null && (d.property.createdBy === session.id || d.property.assignedTo === session.id),
  );
}
