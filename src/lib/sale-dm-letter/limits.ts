/**
 * AI 呼び出しの上限（総点検P3）。
 *
 * ⚠SDK 既定（1試行タイムアウト10分 × 最大3試行）のままだと、50通生成の
 * worst-case が「ワーカーあたり 50÷5=10回の直列呼び出し × 約30分」= 数時間に
 * 達し得る。一方 idempotency の孤児判定（campaigns route の STALE_MS）は
 * 「生成はこの時間内に必ず終わる」を前提にライブなクレームと孤児を区別する
 * ため、生成時間に上限が無いと**生成中のクレームを孤児と誤判定して削除→
 * 同キーで再生成＝AI 課金が二重**になる。上限を明示して worst-case を
 * 計算可能にし、STALE_MS をこの定数から導出する。
 *
 * タイムアウト/リトライ切れは既存の per-item 失敗（本文空 + GENERATION_FAILED）
 * に落ちる = fail-closed。失敗した宛先は regenerate で個別に再生成できる。
 *
 * ⚠providers（claude/openai）と campaigns route の両方が参照するため、
 * index.ts ではなくこの葉モジュールに置く（providers → index は循環になる）。
 */
export const AI_CALL_TIMEOUT_MS = 60_000;

/** リトライ回数（試行回数は AI_MAX_RETRIES + 1）。 */
export const AI_MAX_RETRIES = 1;
