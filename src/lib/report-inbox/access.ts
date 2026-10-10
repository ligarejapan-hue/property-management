/**
 * 査定報告書の受け取り箱を使える人(発注者決定 2026-10-10)。
 * ⚠報告書には依頼者の氏名が載る=**所有者の項目をすべて素通しで見られる人**だけ
 *   (反響資料と同じ判定 canOpenReferralDocument)。加えて物件に添付するので property:write。
 */
import { ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import type { PermissionEntry } from "@/lib/api-helpers";
import { canOpenReferralDocument } from "@/lib/uploads-authorization";

export const REPORT_INBOX_FORBIDDEN_MESSAGE =
  "査定報告書の受け取り箱は、所有者情報をすべて見られる方だけが使えます。管理者にご相談ください。";

export function canUseReportInbox(perms: PermissionEntry[]): boolean {
  return hasPermission(perms, "property", "write") && canOpenReferralDocument(perms);
}

export function assertReportInboxAccess(perms: PermissionEntry[]): void {
  if (!canUseReportInbox(perms)) {
    throw new ApiError(403, REPORT_INBOX_FORBIDDEN_MESSAGE, "FORBIDDEN");
  }
}

/** 受け取り箱のファイルの置き場所(添付とは別の場所)。 */
export function reportInboxStorageKey(now: number, uuid: string): string {
  return `report-inbox/${now}-${uuid}.pdf`;
}
