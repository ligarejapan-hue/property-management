/**
 * 反響資料(referral)添付の**保存名・表示名を作る唯一の決まりごと**。
 *
 * ⚠**元のファイル名を使わない**(@codex PR#414 16巡目 ①)。
 *   反響PDF(査定依頼など)の元名は「佐藤花子様査定依頼.pdf」のように
 *   **それ自体が所有者の氏名を含み得る**。ファイル名は添付一覧・検索・ゴミ箱に
 *   そのまま出るため、所有者の項目別マスクの外へ個人情報が出てしまう。
 *   名前は「種類」と「登録日」という**非PIIの材料だけ**から組み立てる。
 *   (謄本 registry と同じ姿勢。src/lib/attachments/registry-display-name.ts)
 */
import { toJstDateString, encodeRfc5987 } from "./registry-display-name";

/** 添付の種類。⚠`Attachment.type` は String 列なので migration は不要。 */
export const REFERRAL_ATTACHMENT_TYPE = "referral";

/** 非ASCIIを解釈しないクライアント向けのフォールバック名。 */
export const REFERRAL_ASCII_FALLBACK_NAME = "referral.pdf";

/**
 * 反響資料の保存名・表示名。
 *   referralDisplayName(2026-08-26) => "反響資料_2026-08-26.pdf"
 *   referralDisplayName()           => "反響資料.pdf"
 */
export function referralDisplayName(
  createdAt?: Date | string | number | null,
): string {
  const date = toJstDateString(createdAt);
  return date === null ? "反響資料.pdf" : `反響資料_${date}.pdf`;
}

/**
 * 反響資料の Content-Disposition。
 *
 * ⚠**手元に落ちるファイル名を決めるのはここ**（同一オリジンでも Content-Disposition の
 *   filename が指定されていればブラウザはそちらを採る＝画面側の download 属性は効かない）。
 *   registry と同じ形に揃える（src/lib/attachments/registry-display-name.ts）。
 * ⚠元の添付ファイル名（所有者名等を含み得る）は**一切使わない**。
 */
export function referralContentDisposition(args: {
  downloadIntent: boolean;
  createdAt?: Date | string | number | null;
}): string {
  if (!args.downloadIntent) return "inline";
  const name = referralDisplayName(args.createdAt);
  return [
    "attachment",
    `filename="${REFERRAL_ASCII_FALLBACK_NAME}"`,
    `filename*=UTF-8''${encodeRfc5987(name)}`,
  ].join("; ");
}
