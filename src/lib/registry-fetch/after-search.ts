/**
 * 所在検索が終わったあと、**そのまま有料取得へ進んでよいか**の判断（純関数）。
 *
 * 発注者指示(2026-08-21): 候補が1件なら「選ぶ」「確認」を挟まず**そのまま取得へ**進む。
 * 複数件のときは**エラーで止める**（取り違えて別の筆を買わない）。
 *
 * ⚠**中止はすべてに優先する**。謄本は請求が成立すると取り消せないため、止まれるのは
 *   課金の前だけ＝この判断が唯一の砦。中止が押されていたら、候補が1件でも進まない。
 * ⚠**画面に条件を書かない**理由: ここはお金が動く分岐で、文字列の走査では
 *   「順番の取り違え」や「条件の抜け」を確かめられない。純関数にして全条件を実測する。
 */

/** 画面が扱う候補の最小形（api-client の型に依存しない＝テストしやすくする）。 */
export interface SearchCandidateLike {
  candidateRef: string;
}

export type AfterSearchDecision<T extends SearchCandidateLike = SearchCandidateLike> =
  /** 中止が受け付けられている。取得へ進まない（課金ゼロ）。 */
  | { action: "cancelled" }
  /** 候補がちょうど1件。そのまま有料取得へ進む。 */
  | { action: "obtain"; candidate: T }
  /** 候補が複数。取り違えを防ぐため取得しない。 */
  | { action: "too_many"; count: number }
  /** 0件・有料取得が使えない等。従来どおり結果を出すだけ。 */
  | { action: "show_results" };

export function decideAfterSearch<T extends SearchCandidateLike>(input: {
  candidates: T[];
  /** 検索中に中止が押され、受け付けられたか。 */
  cancelRequested: boolean;
  /** 有料取得のスイッチ（切れている環境では必ず 501 になるので自動で進まない）。 */
  purchaseEnabled: boolean;
}): AfterSearchDecision<T> {
  // ⚠**最優先**。ここを他の条件より後ろに置くと、中止したのに課金される。
  if (input.cancelRequested) return { action: "cancelled" };
  if (input.candidates.length > 1) {
    return { action: "too_many", count: input.candidates.length };
  }
  if (input.candidates.length === 1 && input.purchaseEnabled) {
    return { action: "obtain", candidate: input.candidates[0] };
  }
  return { action: "show_results" };
}
