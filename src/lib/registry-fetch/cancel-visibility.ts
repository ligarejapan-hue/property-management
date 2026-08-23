/**
 * 実況パネルの「中止」ボタンを出してよいかの判定。
 *
 * 発注者指示 (2026-08-21):「確定ボタンを押すまでは中止ボタンを出してください。」
 *
 * ## なぜ純関数に出すか
 * 従来は画面側が `state === "searching"`(=無料の所在検索の最中か)だけで決めていた。
 * 候補が1件なら自動で有料取得へ進む今の流れでは、**押せる時間が数秒**しか無い。
 * かといって「実況の文言を読んで課金前かを推測する」のは危険で、文言を1つ変えた
 * だけで**課金中に中止ボタンが出る**(押しても効かないのに押せる = 嘘の表示)。
 *
 * ⇒ 可否は**サーバーが持つ「中止の受付口」の状態**だけで決める。
 *   受付口は有料取得の**課金の直前**で閉じる (それまでは 1 円も動かない)。
 *
 * 純ロジックのみ (fetch / DOM / storage を使わない)。
 */

/** 受付口の状態。`null` = まだ分からない (実況をまだ取得できていない)。 */
export type CancelWindowState = boolean | null;

/** 中止まわりに何を出すか。 */
export type CancelControlView =
  /** 押せる「中止」ボタン。 */
  | "action"
  /** 押した後の「中止しています…」(押せない表示)。 */
  | "pending"
  /** 何も出さない。 */
  | "hidden";

/**
 * 中止まわりの表示を1つに決める。
 *
 * ⚠**押した後を「隠す」にしてはいけない**(@codex #401 R3 P2)。初版は
 *   `cancelRequested` で丸ごと隠していたため、「中止しています…」が
 *   **一度も出せなかった**。押しても即座には止まらない(自動操作が安全な節目まで
 *   進んでから抜ける)ので、受け付けたことが分からないと利用者は
 *   「押せていない」と思って**何度も押す**。
 * ⚠`null`(不明) では押せるボタンを出さない。効かないボタンは
 *   「押したのに止まらない」を生む。出し損ねるのは機会損失で済む。
 * ⚠受付が閉じた後(=課金に入った後)は pending も出さない。「中止しています…」の
 *   まま課金が進むと**止めたつもりなのに請求される**。閉じた理由は
 *   `cancelClosedNotice` が出す。
 */
export function cancelControlView(input: {
  /** サーバーが中止を受け付けられる状態か。 */
  cancelWindowOpen: CancelWindowState;
  /** 実行が終わったか。 */
  done: boolean;
  /** すでに中止を押したか。 */
  cancelRequested: boolean;
}): CancelControlView {
  if (input.done) return "hidden";
  if (input.cancelWindowOpen !== true) return "hidden";
  return input.cancelRequested ? "pending" : "action";
}

/**
 * 押せる「中止」ボタンを出してよいか。
 * `cancelControlView` の "action" と同義 (呼び出し側の可読性のために残す)。
 */
export function shouldShowCancelButton(input: {
  cancelWindowOpen: CancelWindowState;
  done: boolean;
  cancelRequested: boolean;
}): boolean {
  return cancelControlView(input) === "action";
}

/** 受付口が閉じたときの説明。⚠**黙って消さない**。 */
export const CANCEL_WINDOW_CLOSED_MESSAGE =
  "ここから先は中止できません（請求手続き中）";

/**
 * 受付口が閉じたことを知らせる文言 (不要なら null)。
 *
 * ⚠ボタンが黙って消えると「壊れた」と思われる。**なぜ消えたか**を出す。
 * ⚠終わったあとは出さない (結果を見る場面に警告を残さない)。
 */
export function cancelClosedNotice(input: {
  cancelWindowOpen: CancelWindowState;
  done: boolean;
  /** 実行が始まっているか (始まる前は受付口も無いので知らせない)。 */
  started: boolean;
}): string | null {
  if (!input.started) return null;
  if (input.done) return null;
  // ⚠`null`(不明) を「閉じた」と決めつけない。
  if (input.cancelWindowOpen !== false) return null;
  return CANCEL_WINDOW_CLOSED_MESSAGE;
}
