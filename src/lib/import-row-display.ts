/**
 * CSV 取込結果の UI 表示向けヘルパ。
 *
 * 本当にバックエンド側が errorMessage にどういうプレフィックスを載せるかを
 * 1箇所で判定できるようまとめている。Prisma 非依存でテスト可能。
 */

/** errorMessage が重複検知由来かどうか。 */
export function isDuplicateMessage(
  msg: string | null | undefined,
): boolean {
  if (!msg) return false;
  return msg.startsWith("重複");
}

/**
 * errorMessage から「一致理由」ラベルだけを抜き出す。
 *
 * 例: "重複の可能性[住所一致（正規化比較）]: 既存物件ID=xxx (住所)" → "住所一致（正規化比較）"
 * 形式が異なる場合は null を返す。
 */
export function extractDuplicateReason(
  msg: string | null | undefined,
): string | null {
  if (!isDuplicateMessage(msg)) return null;
  const m = msg!.match(/\[([^\]]+)\]/);
  return m ? m[1] : null;
}
