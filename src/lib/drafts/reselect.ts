/** 控えから戻した画面で選び直したファイルが、前回と同じ名前か(設計書 §4.3)。 */
export function isSameFileName(expected: string, chosen: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();
  return norm(expected) === norm(chosen);
}
