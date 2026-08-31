/**
 * 公開エンドポイント(認証なし: /t/ 追跡・/u/ 配信停止)の回数制限。
 *
 * 設計:
 *  - 核はスライディングウィンドウの純関数 decideRate(テストしやすさ・時刻注入)。
 *  - 保持はプロセス内 Map(本番は systemd 単一プロセス運用=インスタンス跨ぎの共有は不要。
 *    多重化したらこの前提が崩れる旨をここに明記しておく)。
 *  - ⚠送信元IPは x-forwarded-for 由来で**偽装可能**(前段プロキシ無し運用ではヘッダは
 *    クライアントが自由に付けられる)。よって per-IP 制限は「行儀の悪い単純クライアント」
 *    向けの尽力ベースであり、書き込み系(/u POST)は必ず**全体上限(鍵固定)**を併用する。
 *  - 鍵数上限(maxKeys)でメモリ枯渇を防ぐ。溢れたときの扱いはエンドポイントの性質で選ぶ:
 *    読み取り系= "allow"(正規利用者を巻き込まない) / 書き込み系= "deny"(fail-closed)。
 */

export interface RateRule {
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  /** 掃除済み+許可時は今回を加えたヒット列(呼び出し側が保存し直す)。 */
  hits: number[];
}

/** 窓内ヒット数で許可/拒否を決める純関数。拒否時はヒットを加えない(拒否連打で窓が伸びない)。 */
export function decideRate(
  hits: readonly number[],
  now: number,
  rule: RateRule,
): RateDecision {
  const floor = now - rule.windowMs;
  const kept = hits.filter((t) => t > floor);
  if (kept.length >= rule.limit) {
    return { allowed: false, hits: kept };
  }
  kept.push(now);
  return { allowed: true, hits: kept };
}

export interface RateLimiterOptions {
  /** 保持する鍵数の上限(既定 10_000)。 */
  maxKeys?: number;
  /** 鍵が溢れて新しい鍵を数えられないときの扱い(既定 "deny")。 */
  onOverflow?: "allow" | "deny";
}

export interface RateLimiter {
  /** 1回のアクセスを数え、許可なら true。now はテスト用の注入(省略時は実時刻)。 */
  hit(key: string, now?: number): boolean;
}

export function createRateLimiter(
  rule: RateRule,
  opts: RateLimiterOptions = {},
): RateLimiter {
  const maxKeys = opts.maxKeys ?? 10_000;
  const onOverflow = opts.onOverflow ?? "deny";
  const store = new Map<string, number[]>();

  function pruneExpired(now: number): void {
    const floor = now - rule.windowMs;
    for (const [k, hits] of store) {
      if (hits.length === 0 || hits[hits.length - 1] <= floor) store.delete(k);
    }
  }

  return {
    hit(key: string, now: number = Date.now()): boolean {
      let hits = store.get(key);
      if (hits === undefined) {
        if (store.size >= maxKeys) {
          pruneExpired(now);
          if (store.size >= maxKeys) return onOverflow === "allow";
        }
        hits = [];
      }
      const d = decideRate(hits, now, rule);
      store.set(key, d.hits);
      return d.allowed;
    },
  };
}

/**
 * レート制限の鍵にする送信元IP。x-forwarded-for 先頭値 → x-real-ip → "unknown"。
 * ⚠上記の偽装可能性の注記どおり、これは識別のヒントであって認証ではない。
 * 長さを切り詰めるのは、でたらめな長大ヘッダで鍵(Map のキー)を肥大させないため。
 */
export function clientRateKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  const raw = first || headers.get("x-real-ip")?.trim() || "unknown";
  return raw.slice(0, 64);
}
