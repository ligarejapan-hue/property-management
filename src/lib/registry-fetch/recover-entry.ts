/**
 * 【回収】購入済みの謄本をどの探し方で取り込むかの判断(2026-08-19)。
 *
 * ⚠**画面から切り出している理由**: 確認パネルのボタンは引数なしで呼ばれるため、
 * 「候補が無い(=検索できない物件から始めた)ときは物件自身の地番で探す」という
 * 判断を画面の中に埋めると、押しても何も起きない状態を作りやすい
 * (実際に作った・@codex #394 R10 P1)。判断はここに置き、単体テストで固定する。
 */
export type RecoverEntry = "candidate" | "property";

export function resolveRecoverEntry(input: {
  /** 物件から始めた回収(所在検索が使えない物件の入口)。 */
  fromProperty: boolean;
  /** 候補(所在検索で選んだ地番)を持っているか。 */
  hasSelection: boolean;
  /**
   * 土地と建物の**両方**が登録されているか。
   * ⚠所在検索は家屋番号(建物)を優先して候補を返すため、候補由来の回収では
   *   **買った土地の謄本に永久に手が届かない**(謄本には取得期限がある)。
   *   両方あるときは人が選んだ種類で、物件自身の地番/家屋番号から探す
   *   (@codex #398 R1 P1)。
   */
  hasBothIdentifiers?: boolean;
}): RecoverEntry {
  // ⚠候補が無いときは**必ず**物件自身の地番で探す(何も起きない、を作らない)。
  if (input.fromProperty || !input.hasSelection) return "property";
  if (input.hasBothIdentifiers) return "property";
  return "candidate";
}
