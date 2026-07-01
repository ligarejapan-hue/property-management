// 販売図面/売土地PDF の出力は1リクエストごとに chromium を1プロセス起動する(output.ts)。
// 無制限だと複数人の同時出力で chromium が多重起動しメモリ/CPU を食い尽くす(soft-DoS)。
// このゲートで「同時に走る出力数」をプロセス内で上限化し、超過分は短時間だけ待たせ、
// それでも空かなければ RenderBusyError(=503 に変換)で穏当に断る。
// 単一プロセス(systemd 1サービス)運用ゆえ、プロセス内セマフォで全体の同時実行を制御できる。

export class RenderBusyError extends Error {
  constructor(
    message = "出力処理が混み合っています。少し待ってから再実行してください",
  ) {
    super(message);
    this.name = "RenderBusyError";
  }
}

export interface RenderGate {
  /** fn をスロット確保下で実行する。容量超過時は待機、acquireTimeoutMs 超で RenderBusyError。 */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** 実行中(スロット確保中)の件数。 */
  active(): number;
  /** 待機列の件数。 */
  queued(): number;
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRenderGate(opts: {
  maxConcurrent: number;
  acquireTimeoutMs: number;
  /** 待機列の上限。超過分は待たせず即 RenderBusyError(待機列の無制限増加=Node側DoSを防ぐ)。既定100。 */
  maxQueue?: number;
}): RenderGate {
  const max = Math.max(1, Math.floor(opts.maxConcurrent) || 1);
  const timeoutMs = Math.max(1, opts.acquireTimeoutMs);
  const maxQueue = Math.max(0, Math.floor(opts.maxQueue ?? 100));
  let active = 0;
  const queue: Waiter[] = [];

  function acquire(): Promise<void> {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    // 待機列が上限なら待たせず即断る(待機列の無制限増加=保留タイマー/Promise/ハンドラ滞留による
    // Node側 soft-DoS の防止)。chromium 同時数だけでなく待機側も有界にする。
    if (queue.length >= maxQueue) {
      return Promise.reject(new RenderBusyError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
        reject(new RenderBusyError()); // timeout は active を奪わない(実行中の件は維持)
      }, timeoutMs);
      queue.push(waiter);
    });
  }

  function release(): void {
    const next = queue.shift();
    if (next) {
      // スロットを次の待機者へ受け渡す(active は据え置き=同じ枠を継承)。
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    } else {
      active--;
    }
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, active: () => active, queued: () => queue.length };
}
