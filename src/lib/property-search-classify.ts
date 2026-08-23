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
/**
 * 拡張子で**終わる**ファイル名(@codex #404 R5 P2)。
 * 「受付帳.xlsx」だけで「そのファイルから取り込んだ物件全部」に絞る旧機能を
 * 統合窓でも使えるようにする。拡張子で終わる文字列は住所・地番ではあり得ない
 * ので曖昧さは無い(⚠拡張子の無い「受付帳」は住所かもしれないので従来どおり
 * keyword 側)。
 */
const FILE_ONLY_RE = /\.(xlsx|xls|csv)\s*$/i;

export function classifyPropertySearch(raw: string): PropertySearchKind {
  const q = raw.trim();
  if (q === "") return "empty";
  if (q.startsWith("__sourceRef")) return "mgmtId";
  if (ROW_SUFFIX_RE.test(q)) return "mgmtId";
  if (FILE_COLON_ROW_RE.test(q)) return "mgmtId";
  if (FILE_ONLY_RE.test(q)) return "mgmtId";
  return "text";
}
