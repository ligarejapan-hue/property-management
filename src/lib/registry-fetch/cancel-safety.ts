/**
 * 謄本の自動取得を「途中で止める」ときの安全規則。
 *
 * 発注者要望 (2026-08-03):
 * 「謄本自動取得の途中で中止するボタンが欲しい。自動操作の実況画面に配置できる？」
 *
 * ⚠**中止は無条件に許してはいけない**。この処理は途中でお金が動く:
 *   候補を探す → 請求条件を確定(無料・カートに載る) → **請求=課金** → PDF取得
 * 課金の後に止めると「**お金は払ったのに書類が手に入らない**」状態を作る。
 * 既存コードが `charged_but_failed` という専用の失敗分類を持っているのは、
 * この状態が実際に起こり得て、かつ利用者に再実行させてはいけないため。
 *
 * したがって規則は 1 つ:
 *   **課金の前なら止めてよい。課金の後は止めない(最後まで取得しきる)。**
 *
 * 純ロジックのみ (fetch / storage / console を使わない)。
 */

/** 中止要求に対する判断。 */
export type CancelDecision =
  /** 止めてよい (まだお金が動いていない)。 */
  | { kind: "stop" }
  /** 止めない (課金済み)。取得を続けて書類を手に入れきる。 */
  | { kind: "ignore-charged" }
  /** そもそも中止は要求されていない。 */
  | { kind: "continue" };

/**
 * 中止してよいか判断する。
 *
 * @param cancelRequested 実行者が中止を押したか
 * @param charged 課金境界を越えたか (`chargeState.charged`)
 *
 * ⚠**charged を先に見る**。要求の有無より優先する順序にしておくと、
 * 「課金後に要求が立った」場合を取りこぼさない。
 */
export function decideCancel(
  cancelRequested: boolean,
  charged: boolean,
): CancelDecision {
  if (!cancelRequested) return { kind: "continue" };
  if (charged) return { kind: "ignore-charged" };
  return { kind: "stop" };
}

/**
 * 課金後に中止を押された利用者へ出す説明 (実況パネル用)。
 * ⚠「止めました」と誤解させない。処理は続いている。
 */
export const CANCEL_IGNORED_CHARGED_MESSAGE =
  "すでに請求(課金)が済んでいるため、ここでは中止できません。お支払い済みの書類を取得しきるまで続けます。";

/** 中止できたときの実況パネル表示。 */
export const CANCEL_ACCEPTED_MESSAGE = "中止しました（課金は発生していません）";
