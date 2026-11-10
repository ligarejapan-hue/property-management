/**
 * 「査定のご報告」の元になる査定報告書の添付(2026-11-11)。
 * - 受け取り箱から「査定報告書」として付けたもの(type=report)
 * - 添付タブから直接付けた一般の書類のうち、種類が「査定書・査定報告書」(doc_kind=appraisal_report)のもの
 * PDF かどうかは読み取りのときに中身で確かめる(isPdfBuffer)。
 */
import { REPORT_ATTACHMENT_TYPE } from "@/lib/attachments/report-display-name";

export const APPRAISAL_DOC_KIND = "appraisal_report";

/** Prisma の attachment の where に足す条件。 */
export const appraisalSourceWhere = {
  OR: [{ type: REPORT_ATTACHMENT_TYPE }, { type: "general", docKind: APPRAISAL_DOC_KIND }],
};

/** 直接付けた添付が「査定のご報告」の元になるか(添付の応答のあとで下書きを作るかどうか)。 */
export function isGeneralAppraisalPdf(a: { type: string; docKind: string | null; mimeType: string }): boolean {
  return a.type === "general" && a.docKind === APPRAISAL_DOC_KIND && a.mimeType === "application/pdf";
}
