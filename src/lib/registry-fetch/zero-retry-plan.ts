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
// ⚠診断(page-probe)の内部予算は 5000ms(auto-fetch の PAGE_PROBE_BUDGET_MS)。
// margin がそれ未満だと「予約したのに診断が途中で切られる」ため、+後始末500ms で 5500。
export const ZERO_RETRY_PROBE_MARGIN_MS = 5500;
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

/**
 * 再オープンのブラウザ操作(閉じる→開き直す→種別→両端の入れ直し。各操作にセレクタ
 * 待ちあり)が実際に食った時間を差し引いて、**2回目の検索を打つ前に**待ちを確定する
 * (@codex #386 R3/R7 P2)。計画(resolveZeroRetryPlan)の式は sleep と診断しか確保して
 * おらず、操作コストは事前に見積もれない(サイトの応答次第)。→ 操作が終わった時点の
 * 実測残量から診断の予約(margin)を守って再計算し、
 * ⚠**ZERO_RETRY_MIN_WAIT_MS を割る待ちしか残らないなら再試行を断念する**(@codex R7)。
 * この最低値未満ではサイトの非同期ロードが終わらず、検索を打っても結果が届く前に
 * 分類してしまう=見かけだけの再試行になる。断念した場合は1回目の0件の観測に基づき
 * 診断→not_found へ進む(呼び出し側)。
 * remainingMs=null は予算未設定=計画値のまま実行。純関数(挙動テスト用)。
 */
export function resolveRetryWaitAfterSetup(
  plannedWaitMs: number,
  remainingMs: number | null,
): { proceed: boolean; waitMs: number } {
  if (remainingMs === null || !Number.isFinite(remainingMs)) {
    return { proceed: true, waitMs: plannedWaitMs };
  }
  const waitMs = Math.min(
    plannedWaitMs,
    remainingMs - ZERO_RETRY_PROBE_MARGIN_MS,
  );
  if (waitMs < ZERO_RETRY_MIN_WAIT_MS) return { proceed: false, waitMs: 0 };
  return { proceed: true, waitMs };
}

/** 診断1回に最低限意味のある時間。これ未満なら診断せず即分類する。 */
export const ZERO_RETRY_PROBE_MIN_MS = 1500;
/** 診断の後始末(キャンセル+分類)に残す時間。margin(5500)−これ=診断の既定内部予算(5000)。 */
export const ZERO_RETRY_PROBE_CLEANUP_MS = 500;
/**
 * 外側タイマーより**必ず先に**分類へ到達するための余白(@codex #386 R6)。
 * 診断とキャンセルが両方とも予算を使い切ると、合計がちょうど残量になる。
 * 外側の soft timer は同じ締切で**先に登録**されているため、同時刻なら外側が勝ち
 * timeout が返る(等号の負け)。予算の合計を締切より確実に手前で終わらせる。
 */
export const ZERO_RETRY_TIMER_HEADROOM_MS = 250;

/**
 * 2回目の0件時点の診断の実行判定(@codex #386 R4 P2)。
 * 予約(carriedProbe)は「**計画時点では**余裕があった」ことしか保証しない。開き直しの
 * ブラウザ操作が margin まで食い込んだ場合、予約どおり5秒の診断を打つと外側タイマー
 * が先に切れ、診断も not_found も届かず timeout に化ける。→ 実測残量から
 *  - 診断がまだ入るか(後始末を引いて最低 ZERO_RETRY_PROBE_MIN_MS 残るか)
 *  - 入るなら内部予算をいくらへ切り詰めるか(上限=診断の既定内部予算)
 * を決め直す。予約が無傷(残量=margin ちょうど)なら既定予算のまま=R2 の
 * 「予約したのに打てない」自己矛盾は起こさない(>= 判定になる)。
 * remainingMs=null は予算未設定=既定の内部予算のまま。純関数(挙動テスト用)。
 */
export function resolveSecondZeroProbe(
  reservedProbe: boolean,
  remainingMs: number | null,
): { probe: boolean; budgetMs: number | null } {
  if (!reservedProbe) return { probe: false, budgetMs: 0 };
  if (remainingMs === null || !Number.isFinite(remainingMs)) {
    return { probe: true, budgetMs: null };
  }
  // ⚠headroom も引く(@codex R6): 診断が budgetMs を使い切り、続くキャンセルも
  // 上限(CLEANUP)まで固まる最悪ケースで、合計を残量ちょうどにしない。同じ締切で
  // 先に登録された外側 soft timer と同時刻に並ぶと、等号で外側が勝ち timeout に
  // 化ける。budgetMs + CLEANUP <= 残量 − HEADROOM を常に保つ。
  const budgetMs = Math.min(
    ZERO_RETRY_PROBE_MARGIN_MS - ZERO_RETRY_PROBE_CLEANUP_MS,
    remainingMs - ZERO_RETRY_PROBE_CLEANUP_MS - ZERO_RETRY_TIMER_HEADROOM_MS,
  );
  if (budgetMs < ZERO_RETRY_PROBE_MIN_MS) return { probe: false, budgetMs: 0 };
  return { probe: true, budgetMs };
}
