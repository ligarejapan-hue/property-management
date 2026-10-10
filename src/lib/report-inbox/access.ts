/**
 * 査定報告書の受け取り箱を使える人(発注者決定 2026-10-10)。
 * ⚠報告書には依頼者の氏名が載る=**所有者の項目をすべて素通しで見られる人**だけ
 *   (反響資料と同じ判定 canOpenReferralDocument)。加えて物件に添付するので property:write。
 */
import { ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import type { PermissionEntry } from "@/lib/api-helpers";
import { canOpenReferralDocument } from "@/lib/uploads-authorization";
import { isPropertyScopedRole } from "@/lib/property-access";

export const REPORT_INBOX_FORBIDDEN_MESSAGE =
  "査定報告書の受け取り箱は、所有者情報をすべて見られる方だけが使えます。管理者にご相談ください。";

export function canUseReportInbox(session: { role: string }, perms: PermissionEntry[]): boolean {
  // ⚠**担当の範囲が限られる役割(現地担当)は使えない**(@codex PR#500 5巡目)。受け取り箱の
  //   報告書はまだどの物件にも付いていないので、担当の範囲で絞れない。使えると、担当外の
  //   物件の報告書(依頼者の氏名入り)を開けたり消せたりしてしまう。
  if (isPropertyScopedRole(session.role)) return false;
  // ⚠property:read も必須(@codex PR#500 2巡目)。候補・検索で物件の住所・建物名・部屋番号を見せる。
  return (
    hasPermission(perms, "property", "read") &&
    hasPermission(perms, "property", "write") &&
    canOpenReferralDocument(perms)
  );
}

/**
 * DB で読むときの担当の範囲(現地担当は自分が作った・担当の物件だけ)。
 * ⚠件数で切る(take)**前**に条件へ入れる(@codex PR#500 2巡目)。後から絞ると、新しい順の
 *   上位が他人の物件で埋まったとき、自分の古い物件が候補・検索に出なくなる。
 */
export function propertyScopeWhere(session: { id: string; role: string }): Record<string, unknown> {
  if (!isPropertyScopedRole(session.role)) return {};
  return { OR: [{ createdBy: session.id }, { assignedTo: session.id }] };
}

export function assertReportInboxAccess(session: { role: string }, perms: PermissionEntry[]): void {
  if (!canUseReportInbox(session, perms)) {
    throw new ApiError(403, REPORT_INBOX_FORBIDDEN_MESSAGE, "FORBIDDEN");
  }
}

/** 受け取り箱のファイルの置き場所(添付とは別の場所)。 */
export function reportInboxStorageKey(now: number, uuid: string): string {
  return `report-inbox/${now}-${uuid}.pdf`;
}
