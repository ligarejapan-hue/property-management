import { describe, it, expect, vi } from "vitest";
import { createRenderGate, RenderBusyError } from "../render-gate";

// 制御可能な非同期タスク(解放タイミングを手で握る)。
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createRenderGate: 同時実行を maxConcurrent に制限(chromium枯渇=soft-DoS防止)", () => {
  it("maxConcurrent までは並行で走る(active が上限まで増える)", async () => {
    const gate = createRenderGate({ maxConcurrent: 2, acquireTimeoutMs: 1000 });
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    let started = 0;
    const p1 = gate.run(async () => { started++; return d1.promise; });
    const p2 = gate.run(async () => { started++; return d2.promise; });
    expect(gate.active()).toBe(2); // 容量内ゆえ即取得(同期的に active 加算)
    await tick();
    expect(started).toBe(2);
    d1.resolve("a");
    d2.resolve("b");
    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
    expect(gate.active()).toBe(0);
  });

  it("容量超過分は待機し、解放されたら順に実行する(FIFO・3つ目以降は走らない)", async () => {
    const gate = createRenderGate({ maxConcurrent: 1, acquireTimeoutMs: 1000 });
    const d1 = deferred<string>();
    const order: string[] = [];
    const p1 = gate.run(async () => { order.push("start1"); return d1.promise; });
    let started2 = false;
    const p2 = gate.run(async () => { started2 = true; order.push("start2"); return "2"; });
    await tick();
    expect(started2).toBe(false); // 容量1=待機中(まだ走らない)
    expect(gate.queued()).toBe(1);
    expect(gate.active()).toBe(1);
    d1.resolve("1");
    expect(await p1).toBe("1");
    expect(await p2).toBe("2");
    expect(started2).toBe(true);
    expect(order).toEqual(["start1", "start2"]); // 先入れ先出し
    expect(gate.active()).toBe(0);
    expect(gate.queued()).toBe(0);
  });

  it("待機が acquireTimeoutMs を超えたら RenderBusyError(slotは塞がず queue から除去)", async () => {
    vi.useFakeTimers();
    try {
      const gate = createRenderGate({ maxConcurrent: 1, acquireTimeoutMs: 50 });
      const d1 = deferred<string>();
      const p1 = gate.run(() => d1.promise); // 唯一のslotを保持
      const p2 = gate.run(async () => "should-not-run"); // 待機→timeout
      const busy = expect(p2).rejects.toBeInstanceOf(RenderBusyError);
      await vi.advanceTimersByTimeAsync(60);
      await busy;
      expect(gate.queued()).toBe(0); // timeout した待機者は queue から消える
      expect(gate.active()).toBe(1); // 実行中の1件は維持(timeout は slot を奪わない)
      d1.resolve("1");
      await p1;
      expect(gate.active()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("run 内で例外が出ても slot は解放される(後続が動ける)", async () => {
    const gate = createRenderGate({ maxConcurrent: 1, acquireTimeoutMs: 1000 });
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(gate.active()).toBe(0);
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  it("待機列が maxQueue を超えたら即 RenderBusyError(待機列も無制限に積まない=Node側DoS防止)", async () => {
    const gate = createRenderGate({ maxConcurrent: 1, acquireTimeoutMs: 10000, maxQueue: 2 });
    const d = deferred<string>();
    const p1 = gate.run(() => d.promise); // 唯一のslotを保持(active=1)
    const p2 = gate.run(async () => "q1"); // 待機1
    const p3 = gate.run(async () => "q2"); // 待機2(満杯)
    expect(gate.queued()).toBe(2);
    const overflow = gate.run(async () => "overflow"); // 満杯超
    overflow.catch(() => {}); // unhandled rejection 抑止
    expect(gate.queued()).toBe(2); // 満杯超は積み増さない(即時reject)
    await expect(overflow).rejects.toBeInstanceOf(RenderBusyError);
    d.resolve("done");
    expect(await p1).toBe("done");
    expect(await p2).toBe("q1");
    expect(await p3).toBe("q2");
    expect(gate.active()).toBe(0);
  });

  it("maxConcurrent は最低1に丸める(0/負値でも停止しない)", async () => {
    const gate = createRenderGate({ maxConcurrent: 0, acquireTimeoutMs: 1000 });
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  it("RenderBusyError は名前と既定メッセージを持つ", () => {
    const e = new RenderBusyError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RenderBusyError");
    expect(e.message.length).toBeGreaterThan(0);
  });
});
