/**
 * 地番検索ダイアログ「0件リトライ」の予算配分(純関数)。
 * auto-fetch.ts から分離しているのは、テストが auto-fetch を import すると
 * その依存(audit→next-auth→next/server)ごと引き込んで node 環境で落ちるため。
 * ⚠DIALOG_RESULT_TIMEOUT_MS(15000)と同値を持つ。auto-fetch 側の待ちの正本は
 * あちらの定数のままで、ここは「上限」としてのみ使う。
 */

/** ダイアログ結果待ちの上限(auto-fetch の DIALOG_RESULT_TIMEOUT_MS と同値)。 */
export const ZERO_RETRY_MAX_WAIT_MS = 15000;
/** 0件リトライ1回に使う固定コスト(閉じて開き直すまでの待ち)。 */
export const ZERO_RETRY_SLEEP_MS = 1500;
/** 診断(page-probe)+キャンセル+分類に残す安全マージン。 */
export const ZERO_RETRY_PROBE_MARGIN_MS = 4000;
/** これ未満の待ちで再検索しても意味がない(サイトの非同期ロードが終わらない)。 */
export const ZERO_RETRY_MIN_WAIT_MS = 3000;

/**
 * 0件リトライの予算配分(@codex #386 P2)。外側の provider 予算
 * (REGISTRY_FETCH_TIMEOUT_MS・例30秒)の中に「1回目の待ち15s+sleep+2回目の待ち15s」は
 * 収まらないことがある。収まらないまま走ると、**not_found にも診断にも到達できず**
 * 外側 timeout で page ごと閉じられ、呼び出し側には timeout が返る(0件の事実が消える)。
 * 残り予算から「再試行するか・2回目を何ms待つか・診断を打つ余裕があるか」を決める。
 * remainingMs=null は予算未設定(env なし)=従来どおりフル。純関数(挙動テスト用)。
 */
export function resolveZeroRetryPlan(remainingMs: number | null): {
  retry: boolean;
  waitMs: number;
  probe: boolean;
} {
  if (remainingMs === null || !Number.isFinite(remainingMs)) {
    return { retry: true, waitMs: ZERO_RETRY_MAX_WAIT_MS, probe: true };
  }
  const waitBudget = remainingMs - ZERO_RETRY_SLEEP_MS - ZERO_RETRY_PROBE_MARGIN_MS;
  if (waitBudget < ZERO_RETRY_MIN_WAIT_MS) {
    // 再試行の余裕なし。診断だけでも打てるなら打つ(次回の原因特定を捨てない)。
    return { retry: false, waitMs: 0, probe: remainingMs > ZERO_RETRY_PROBE_MARGIN_MS };
  }
  return {
    retry: true,
    waitMs: Math.min(ZERO_RETRY_MAX_WAIT_MS, waitBudget),
    probe: true,
  };
}
