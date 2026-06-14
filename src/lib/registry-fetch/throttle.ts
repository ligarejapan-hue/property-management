/**
 * 謄本自動取得 — レート制御ラッパ（PR-1 scaffold）。
 *
 * 公式「登記情報提供サービス」約款 第12条の2（過度な検索 → 利用制限）を踏まえ、
 * 自動取得の頻度を保守的に抑えるための薄いラッパ。**新しいレート制御アルゴリズムは
 * 発明せず**、既存の in-process token-bucket（{@link createTokenBucketLimiter}）を
 * 再利用する。単一 Node プロセス前提（本番 VPS は単一プロセス）。
 *
 * PR-1 では「最小間隔ガード（token-bucket で表現）」のみを提供する。利用時間帯ガードや
 * 日次上限など、より重い運用制御は実 provider（PR-2 以降）と運用条件確定後に拡張する。
 *
 * nowMs を引数で受けることで純粋・決定的にし、外部接続なしで単体テストできる。
 */
import {
  createTokenBucketLimiter,
  type TokenBucketLimiter,
} from "@/lib/token-bucket";

/**
 * 自動取得のレート制御スロットラ。
 * key（例: provider 名 / 単一グローバルキー）ごとに 1 取得分の許可を試みる。
 */
export interface RegistryFetchThrottle {
  /**
   * 1 取得分の許可を試みる。許可できれば true、レート超過なら false。
   * false のとき呼び出し側は rate_limited として安全に停止することを想定する。
   */
  tryAcquire(key: string, nowMs: number): boolean;
}

export interface RegistryFetchThrottleOptions {
  /**
   * 取得間の最小間隔（ミリ秒）。第12条の2 回避の保守的既定として大きめに取る。
   * 既定 60000ms（= 1 件/分）。
   */
  minIntervalMs?: number;
  /**
   * 短時間のバースト許容数（token-bucket の容量）。既定 1（バーストを許さず直列化）。
   */
  burst?: number;
  /** テスト用に limiter を注入できる（未指定なら token-bucket を内部生成）。 */
  limiter?: TokenBucketLimiter;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_BURST = 1;

/**
 * 最小間隔ガードを token-bucket で表現したスロットラを生成する。
 *
 * refillPerSec = 1000 / minIntervalMs にすることで「minIntervalMs ごとに 1 トークン補充」
 * = 「最小間隔ガード」を既存 token-bucket でそのまま表現する（新規実装はしない）。
 */
export function createRegistryFetchThrottle(
  options: RegistryFetchThrottleOptions = {},
): RegistryFetchThrottle {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const burst = options.burst ?? DEFAULT_BURST;

  if (!(minIntervalMs > 0)) {
    throw new Error("minIntervalMs must be > 0");
  }
  if (!(burst >= 1)) {
    throw new Error("burst must be >= 1");
  }

  const limiter =
    options.limiter ??
    createTokenBucketLimiter({
      capacity: burst,
      // minIntervalMs ごとに 1 トークン → 最小間隔ガード。
      refillPerSec: 1000 / minIntervalMs,
    });

  return {
    tryAcquire(key: string, nowMs: number): boolean {
      return limiter.tryConsume(key, nowMs);
    },
  };
}
