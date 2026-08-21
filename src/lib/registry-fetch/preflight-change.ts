/**
 * 検索の前後で「取得済み・PDF添付あり・所有者あり」の警告が**増えたか**（純関数）。
 *
 * ⚠なぜ要るか（@codex #399 R2 P1）: 所在検索は数十秒〜数分かかる。その間に**別の担当者**が
 *   謄本PDFを添付したり所有者を追加したりすると、検索前に見た警告のまま自動で課金され、
 *   **重複して買ってしまう**（謄本の課金は取り消せない）。
 *   増えていたら自動で進まず、確認画面で人に判断させる。
 * ⚠**確かめられないときは止める側に倒す**（fail closed）。お金は取り戻せない。
 * ⚠もともと出ていた警告では止めない。検索前にそれを見たうえで進めた人の判断を覆さない。
 */
export interface PreflightWarningFlags {
  /** 登記状況が「取得済」か。 */
  registryObtained: boolean;
  /** 謄本PDF(未削除)が既に添付されているか。 */
  hasRegistryAttachment: boolean;
  /** 所有者が1名以上リンク済みか。 */
  hasOwners: boolean;
}

const WARNING_KEYS = [
  "registryObtained",
  "hasRegistryAttachment",
  "hasOwners",
] as const;

export function preflightWarningsIncreased(
  before: PreflightWarningFlags | null,
  after: PreflightWarningFlags | null,
): boolean {
  // 取り直せなかった＝今の状態が分からない。課金は取り消せないので止める。
  if (after === null) return true;
  return WARNING_KEYS.some((k) => after[k] && !(before?.[k] ?? false));
}
