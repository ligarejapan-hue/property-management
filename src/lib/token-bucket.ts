/**
 * S1b-3: プロセス内 token-bucket rate limiter。
 *
 * client 監査 POST(/api/me/audit-events) の濫用・スパムを抑える best-effort 防御。
 * 単一 Node プロセス前提（本番 VPS は単一プロセス）。複数インスタンス / serverless では
 * 別途共有ストア(例: Redis)が必要。監査は best-effort のため、超過時は記録を捨てるだけで
 * ユーザーの本来の操作は妨げない。
 *
 * nowMs を引数で受けることで純粋・決定的にし、node 環境で単体テストできる。
 */
export interface TokenBucketLimiter {
  /** key(=userId) ごとに 1 トークン消費を試みる。消費できれば true、枯渇なら false。 */
  tryConsume(key: string, nowMs: number): boolean;
}

export function createTokenBucketLimiter(opts: {
  /** バケット容量（バースト上限）。 */
  capacity: number;
  /** 1 秒あたりの補充トークン数（例: 1 = 60/min）。 */
  refillPerSec: number;
}): TokenBucketLimiter {
  const { capacity, refillPerSec } = opts;
  const state = new Map<string, { tokens: number; lastMs: number }>();

  return {
    tryConsume(key: string, nowMs: number): boolean {
      const cur = state.get(key) ?? { tokens: capacity, lastMs: nowMs };
      const elapsedSec = Math.max(0, nowMs - cur.lastMs) / 1000;
      const tokens = Math.min(capacity, cur.tokens + elapsedSec * refillPerSec);

      if (tokens < 1) {
        state.set(key, { tokens, lastMs: nowMs });
        return false;
      }
      state.set(key, { tokens: tokens - 1, lastMs: nowMs });
      return true;
    },
  };
}
