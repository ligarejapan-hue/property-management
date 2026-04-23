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

/** errorMessage が CSV update 実行由来かどうか。 */
export function isUpdateMessage(
  msg: string | null | undefined,
): boolean {
  if (!msg) return false;
  return msg.startsWith("更新");
}

/**
 * errorMessage から update の「一致理由」ラベルだけを抜き出す。
 *
 * 例: "更新[realEstateNumber一致]: 既存物件ID=xxx (更新項目: address, note)" → "realEstateNumber一致"
 */
export function extractUpdateReason(
  msg: string | null | undefined,
): string | null {
  if (!isUpdateMessage(msg)) return null;
  const m = msg!.match(/\[([^\]]+)\]/);
  return m ? m[1] : null;
}

/**
 * errorMessage から更新されたフィールド名一覧を抜き出す。
 *
 * 例: "更新[...]: 既存物件ID=xxx (更新項目: address, note)" → ["address", "note"]
 * 見つからなければ空配列。
 */
export function extractUpdatedFields(
  msg: string | null | undefined,
): string[] {
  if (!isUpdateMessage(msg)) return [];
  const m = msg!.match(/更新項目:\s*([^)]+)\)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
