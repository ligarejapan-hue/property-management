/**
 * 統合検索窓の入力の見分け (UI一貫性 第1弾 ①)。
 *
 * 物件一覧の検索窓3連を1本に統合するための判定。純関数。
 *
 * ⚠**曖昧な入力は必ず keyword(住所・地番)側に倒す**:
 *   - 素の数字「120」は地番の一部であり得る(実在: 地番 180-1 等)
 *   - 「受付帳」はファイル名でも住所の一部でもあり得る
 *   管理ID扱いは**明確な構文のときだけ**。従来の管理ID窓が受けていた
 *   「素の数字」「ファイル名だけ」は行サフィックス(「120行」)で表す
 *   (placeholder で例示する)。
 *
 * 構文は既存の管理ID検索(property-mgmt-id-search.ts)が受けるものの部分集合:
 *   「120行」「受付帳.xlsx:120行」「受付帳.xlsx:120」「◯.csv：45」(全角コロン可)
 *   「__sourceRef…」
 */
export type PropertySearchKind = "empty" | "mgmtId" | "text";

/** 数字+「行」(前後空白可・末尾)。 */
const ROW_SUFFIX_RE = /\d+\s*行\s*$/;
/** 拡張子+コロン(全角可)+数字。ファイル名の一部だけでは一致しない。 */
const FILE_COLON_ROW_RE = /\.(xlsx|xls|csv)\s*[:：]\s*\d+/i;

export function classifyPropertySearch(raw: string): PropertySearchKind {
  const q = raw.trim();
  if (q === "") return "empty";
  if (q.startsWith("__sourceRef")) return "mgmtId";
  if (ROW_SUFFIX_RE.test(q)) return "mgmtId";
  if (FILE_COLON_ROW_RE.test(q)) return "mgmtId";
  return "text";
}
