import { INQUIRY_KINDS, INQUIRY_STATUSES } from "./constants";

/**
 * 監査に書いてよい項目名(設計 §4)。値は書かない=問い合わせ者の名前・携帯・メール・メモ・
 * 内見の結果の中身が監査ログに残らない。許可リスト方式(危ないものを除くのではなく、
 * 安全なものだけで組み立てる)。
 */
const FIELD_NAMES = new Set([
  "propertyId", "agentId", "contactName", "contactMobile", "contactEmail", "kind", "channel", "status", "assigneeId", "note",
  "companyName", "companyKana", "branchName", "licenseNo", "phone", "fax", "email", "address", "isArchived",
  "scheduledAt", "viewingType", "attendantId", "resultNote", "canceled", "adPermissions",
]);

export function inquiryAuditDetail(changed: string[], extra: { status?: string; kind?: string } = {}) {
  const out: Record<string, unknown> = { changed: changed.filter((f) => FIELD_NAMES.has(f)).sort() };
  if (extra.status && (INQUIRY_STATUSES as readonly string[]).includes(extra.status)) out.status = extra.status;
  if (extra.kind && (INQUIRY_KINDS as readonly string[]).includes(extra.kind)) out.kind = extra.kind;
  return out;
}
