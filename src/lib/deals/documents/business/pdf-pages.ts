/** PDF のページ数(ページの辞書 `/Type /Page` の数。`/Pages` は数えない)。精算書を2枚目に回すかを決めるのに使う。 */
export function pdfPageCount(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}
