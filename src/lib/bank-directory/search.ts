/**
 * 金融機関・支店の候補の探し方(純関数)。1文字目から出す(2026-11-17 発注者)。
 * - 先頭一致: 正式な名前・読み(ひらがなにそろえた形)・ローマ字・コードのどれかが、打った字で始まる
 * - 2文字以上なら、名前か読みの途中に含むものも先頭一致の後ろに出す(1文字だと多すぎるので出さない)
 * - 同じ組の中はコードの順(大きな銀行ほどコードが小さい)
 */
import { toSearchKey } from "./names";

export type DirectoryEntry = {
  code: string;
  /** 正式な名前(入力欄に入れる形)。 */
  name: string;
  /** 読み(toSearchKey でそろえた形)。 */
  kana: string;
  /** ローマ字(元データのまま・小文字)。 */
  roma: string;
};

export const DIRECTORY_SEARCH_LIMIT = 20;

export function searchDirectory<T extends DirectoryEntry>(q: string, entries: readonly T[], limit = DIRECTORY_SEARCH_LIMIT): T[] {
  const key = toSearchKey(q);
  if (key === "") return [];
  const byCode = (a: T, b: T) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const x of entries) {
    const name = toSearchKey(x.name);
    if (name.startsWith(key) || x.kana.startsWith(key) || x.roma.startsWith(key) || x.code.startsWith(key)) {
      prefix.push(x);
    } else if (key.length >= 2 && (name.includes(key) || x.kana.includes(key))) {
      contains.push(x);
    }
  }
  return [...prefix.sort(byCode), ...contains.sort(byCode)].slice(0, limit);
}
