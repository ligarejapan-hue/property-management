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
export type PropertySearchKind =
  | "empty"
  | "mgmtId"
  /**
   * 管理IDに**なりかけ**の形(@codex #404 R9 P2)。「受付帳.xl」「◯.xlsx:」
   * 「id:」等、打っている途中で 300ms 止まると部分文字列が keyword として
   * 確定し URL/property_list 監査に残ってしまう。なりかけは**確定を保留**する
   * (呼び出し側は何もコミットしない)。
   */
  | "mgmtIdPartial"
  | "text";

/**
 * 数字+「行」だけの完全形(@codex #404 R8 P2: **全体一致**)。
 * 途中一致にすると「120行目」等が管理ID扱いになるが、server の parseMgmtIdQuery は
 * それを行番号と解釈できず**ファイル名ヒント扱い=別の絞り込み**になってしまう。
 * 分類は server が解釈できる完全な構文だけに絞る(それ以外は keyword=安全側)。
 */
const ROW_SUFFIX_RE = /^\d+\s*行$/;
/** ファイル名+コロン(全角可)+行番号(+任意の「行」)の完全形。 */
const FILE_COLON_ROW_RE = /^[^:：]*\.(xlsx|xls|csv)\s*[:：]\s*\d+(\s*行)?$/i;
/**
 * 拡張子で**終わる**ファイル名(@codex #404 R5 P2)。
 * 「受付帳.xlsx」だけで「そのファイルから取り込んだ物件全部」に絞る旧機能を
 * 統合窓でも使えるようにする。拡張子で終わる文字列は住所・地番ではあり得ない
 * ので曖昧さは無い(⚠拡張子の無い「受付帳」は住所かもしれないので従来どおり
 * keyword 側)。
 */
const FILE_ONLY_RE = /\.(xlsx|xls|csv)\s*$/i;
/**
 * 明示の接頭辞(@codex #404 R6 P2)。CSV出力の「管理ID」列の生値(__sourceRef
 * そのもの・例: MGMT-001)は構文を持たないため自動では見分けられない。
 * 「id:◯◯」「管理ID:◯◯」(全角コロン可)で**任意の値**を管理ID検索へ通す。
 */
const EXPLICIT_PREFIX_RE = /^(id|管理ID)\s*[:：]\s*(\S.*)$/i;
/** なりかけ: 末尾がドット+拡張子の断片(「受付帳.」「◯.x」「◯.xl」等)。 */
const PARTIAL_EXT_RE = /\.[a-z]{0,3}$/i;
/** なりかけ: 拡張子+コロンまで(行番号がまだ)。 */
const PARTIAL_COLON_RE = /\.(xlsx|xls|csv)\s*[:：]\s*$/i;
/** なりかけ: 明示接頭辞の途中(「id」「id:」「管理ID：」)。 */
const PARTIAL_PREFIX_RE = /^(id|管理ID)\s*[:：]?\s*$/i;

export function classifyPropertySearch(raw: string): PropertySearchKind {
  const q = raw.trim();
  if (q === "") return "empty";
  if (q.startsWith("__sourceRef")) return "mgmtId";
  if (ROW_SUFFIX_RE.test(q)) return "mgmtId";
  if (FILE_COLON_ROW_RE.test(q)) return "mgmtId";
  if (FILE_ONLY_RE.test(q)) return "mgmtId";
  if (EXPLICIT_PREFIX_RE.test(q)) return "mgmtId";
  // ⚠なりかけの判定は**完全形の後**(「.xls」「.csv」等の完全な拡張子は上で
  //   mgmtId 確定済みなので、ここに来るのは本当に途中の形だけ)。
  if (PARTIAL_COLON_RE.test(q)) return "mgmtIdPartial";
  if (PARTIAL_PREFIX_RE.test(q)) return "mgmtIdPartial";
  if (PARTIAL_EXT_RE.test(q)) return "mgmtIdPartial";
  return "text";
}

/**
 * mgmtId 検索へ送る実クエリ。明示の接頭辞(「id:」「管理ID:」)は剥がして
 * 中身だけを送る(server の parseMgmtIdQuery は生値で照合するため)。
 * それ以外の管理ID構文(「120行」等)は server 側が解釈するのでそのまま返す。
 */
export function toMgmtIdQuery(raw: string): string {
  const q = raw.trim();
  const m = q.match(EXPLICIT_PREFIX_RE);
  return m ? m[2] : q;
}
