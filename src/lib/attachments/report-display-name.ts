/**
 * 査定報告書(report)添付の**保存名・表示名を作る唯一の決まりごと**(2026-10-10)。
 *
 * ⚠**元のファイル名を使わない**。報告書には依頼者の氏名が載り、元の名前にも
 *   含まれ得る。名前は「種類」と「登録日」という非PIIの材料だけから組み立てる
 *   (反響資料 referral-display-name.ts と同じ姿勢)。
 * ⚠開ける人も反響資料と同じ(所有者の項目をすべて素通しで見られる人だけ・
 *   uploads-authorization.ts の isOwnerPiiDocumentType)。
 */
import { toJstDateString, encodeRfc5987 } from "./registry-display-name";

/** 添付の種類。⚠`Attachment.type` は String 列なので migration は不要。 */
export const REPORT_ATTACHMENT_TYPE = "report";

/** 非ASCIIを解釈しないクライアント向けのフォールバック名。 */
export const REPORT_ASCII_FALLBACK_NAME = "report.pdf";

/**
 * 査定報告書の保存名・表示名。
 *   reportDisplayName(2026-10-10) => "査定報告書_2026-10-10.pdf"
 *   reportDisplayName()           => "査定報告書.pdf"
 */
export function reportDisplayName(createdAt?: Date | string | number | null): string {
  const date = toJstDateString(createdAt);
  return date === null ? "査定報告書.pdf" : `査定報告書_${date}.pdf`;
}

/** 査定報告書の Content-Disposition(referralContentDisposition と同じ形)。 */
export function reportContentDisposition(args: {
  downloadIntent: boolean;
  createdAt?: Date | string | number | null;
}): string {
  if (!args.downloadIntent) return "inline";
  const name = reportDisplayName(args.createdAt);
  return [
    "attachment",
    `filename="${REPORT_ASCII_FALLBACK_NAME}"`,
    `filename*=UTF-8''${encodeRfc5987(name)}`,
  ].join("; ");
}
