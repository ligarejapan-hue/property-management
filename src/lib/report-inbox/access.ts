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
  // ⚠取り込みの口なので import:write も必須(他の取り込み=貼り付けて物件化・CSV と同じ境界・18巡目)。
  return (
    hasPermission(perms, "import", "write") &&
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

/**
 * 処理が済んだ(削除・添付)行から、個人情報になりうる中身を消すための値(@codex PR#500 8巡目)。
 * ⚠元のファイル名は依頼者名を含み得る。削除した行は読み取った所在地・建物名も残さない。
 *   行そのものは「同時に押されたときの判定」のために残す(中身の無い記録)。
 */
export const SCRUBBED_FILE_NAME = "(処理済み)";
export const SCRUB_ON_DISCARD = {
  fileName: SCRUBBED_FILE_NAME,
  buildingName: null,
  roomNo: null,
  address: null,
} as const;

/**
 * 取り込みが途中で止まった(記録は作ったがファイルを置き終えていない)とみなすまでの時間。
 * ⚠これより新しい「取り込み中」は**いま取り込んでいる最中**の可能性があるので、一覧に出さず
 *   削除もさせない(@codex PR#500 11巡目)。動いている受け取りの記録を横から「削除済み」にすると、
 *   そのあと置かれたファイルが残る。受け取りは圧縮の打ち切り(2分)+保存で数分以内に終わるので、
 *   1時間たっても「取り込み中」なら、その受け取りは止まっている(プロセスの停止など)。
 */
export const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** 受け取り箱のファイルの置き場所(添付とは別の場所)。 */
export function reportInboxStorageKey(now: number, uuid: string): string {
  return `report-inbox/${now}-${uuid}.pdf`;
}
