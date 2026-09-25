/**
 * 見ている側の司令塔(createEditLockStatusController)を node で実挙動テストする。
 *
 * ⚠このリポジトリは jsdom も renderHook も使わない(vitest.config.ts が
 *   environment: "node" を固定)。`use-edit-lock-status.ts` は結線だけなので
 *   source assertion で足りる(`controller.test.ts` / `use-edit-lock.test.ts` と
 *   同じ役割分担)。
 *
 * `deps.setInterval` / `deps.clearInterval` は本物のタイマーを使わず、
 * このテストが持つ「登録簿」に差し替える。周期は登録された関数を手で1回呼んで
 * 発火させ、内部の `await` を挟む非同期処理は `flush()` でマイクロタスクを
 * 掃き出してから結果を見る(`controller.test.ts` と同じやり方)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createEditLockStatusController,
  findEditLockStatusRow,
  EDIT_LOCK_STATUS_CHUNK_SIZE,
  type EditLockStatusControllerDeps,
  type EditLockStatusResource,
} from "../status-controller";
import type { EditLockStatusRow } from "@/lib/api-client";
import { EDIT_LOCK_STATUS_POLL_MS } from "../rules";

/** マイクロタスクを掃き出す(controller 内の await 1〜2段を進める)。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 手で解決のタイミングを操る Promise(応答の到着順を入れ替えるテスト用)。 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** `deps.setInterval`/`clearInterval` の偽物。登録簿(Map)を持ち、`fire()` は今アクティブな間隔コールバックを1回だけ手で呼ぶ。 */
function createIntervalRegistry() {
  let nextHandle = 1;
  const active = new Map<number, () => void>();
  const setIntervalCalls: Array<{ ms: number }> = [];
  const setInterval = vi.fn((fn: () => void, ms: number): unknown => {
    const handle = nextHandle++;
    active.set(handle, fn);
    setIntervalCalls.push({ ms });
    return handle;
  });
  const clearInterval = vi.fn((handle: unknown): void => {
    active.delete(handle as number);
  });
  async function fire(): Promise<void> {
    for (const fn of [...active.values()]) fn();
    await flush();
  }
  return { setInterval, clearInterval, fire, activeCount: () => active.size, setIntervalCalls };
}

function row(resourceType: "property" | "owner", resourceId: string, state: EditLockStatusRow["state"] = "free"): EditLockStatusRow {
  return { resourceType, resourceId, state };
}

interface Harness {
  deps: EditLockStatusControllerDeps;
  fetchStatusMock: ReturnType<typeof vi.fn>;
  onRowsMock: ReturnType<typeof vi.fn>;
  registry: ReturnType<typeof createIntervalRegistry>;
  hidden: { value: boolean };
}

function createHarness(): Harness {
  const registry = createIntervalRegistry();
  const fetchStatusMock = vi.fn<(resources: EditLockStatusResource[]) => Promise<EditLockStatusRow[]>>();
  const onRowsMock = vi.fn<(rows: EditLockStatusRow[]) => void>();
  const hidden = { value: false };
  const deps: EditLockStatusControllerDeps = {
    fetchStatus: fetchStatusMock,
    onRows: onRowsMock,
    setInterval: registry.setInterval,
    clearInterval: registry.clearInterval,
    isHidden: () => hidden.value,
  };
  return { deps, fetchStatusMock, onRowsMock, registry, hidden };
}

const P1: EditLockStatusResource = { resourceType: "property", resourceId: "p1" };

describe("createEditLockStatusController", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it("1) 開いたとき1回・以後 EDIT_LOCK_STATUS_POLL_MS ごとに1回だけ呼ぶ", async () => {
    h.fetchStatusMock.mockResolvedValue([row("property", "p1")]);
    const controller = createEditLockStatusController(h.deps);

    controller.start([P1]);
    await flush();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(1);
    expect(h.registry.setIntervalCalls).toEqual([{ ms: EDIT_LOCK_STATUS_POLL_MS }]);

    await h.registry.fire();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(2);

    await h.registry.fire();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(3);
  });

  it("2) isHidden() が true の回は呼ばない→false に戻った回で再開する", async () => {
    h.fetchStatusMock.mockResolvedValue([row("property", "p1")]);
    const controller = createEditLockStatusController(h.deps);
    controller.start([P1]);
    await flush();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(1);

    h.hidden.value = true;
    await h.registry.fire();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(1); // 隠れている間は呼ばれない

    await h.registry.fire();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(1); // 隠れたままなら何度でも呼ばれない

    h.hidden.value = false;
    await h.registry.fire();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(2); // 表に戻った回で再開する
  });

  it("3) 50件を超える資源は分割して呼ぶ(51件 → 2回。1回目50件・2回目1件)", async () => {
    h.fetchStatusMock.mockResolvedValue([]);
    const resources: EditLockStatusResource[] = Array.from({ length: 51 }, (_, i) => ({
      resourceType: "owner" as const,
      resourceId: `o${i}`,
    }));
    const controller = createEditLockStatusController(h.deps);

    controller.start(resources);
    await flush();

    expect(h.fetchStatusMock).toHaveBeenCalledTimes(2);
    expect(h.fetchStatusMock.mock.calls[0][0]).toHaveLength(EDIT_LOCK_STATUS_CHUNK_SIZE);
    expect(h.fetchStatusMock.mock.calls[1][0]).toHaveLength(1);
    expect(h.fetchStatusMock.mock.calls[0][0]).toEqual(resources.slice(0, 50));
    expect(h.fetchStatusMock.mock.calls[1][0]).toEqual(resources.slice(50));
  });

  it("4) refresh() で即座に1回呼ぶ(管理者が鍵を外した直後に使う。isHiddenでも呼ぶ)", async () => {
    h.fetchStatusMock.mockResolvedValue([row("property", "p1")]);
    const controller = createEditLockStatusController(h.deps);
    controller.start([P1]);
    await flush();
    h.fetchStatusMock.mockClear();

    h.hidden.value = true;
    controller.refresh();
    await flush();
    expect(h.fetchStatusMock).toHaveBeenCalledTimes(1);
  });

  it("5) 資源の一覧が変わったら古い応答で onRows を呼ばない(seq で stale を捨てる)", async () => {
    const pending = createDeferred<EditLockStatusRow[]>();
    h.fetchStatusMock.mockReturnValueOnce(pending.promise);
    const controller = createEditLockStatusController(h.deps);
    controller.start([P1]);
    await flush();
    expect(h.onRowsMock).not.toHaveBeenCalled();

    // 応答が届く前に資源の一覧が変わる(所有者が増減した等)。
    controller.setResources([{ resourceType: "owner", resourceId: "o1" }]);

    // 古い一覧([P1])に対する応答が遅れて届く。
    pending.resolve([row("property", "p1", "held_by_other")]);
    await flush();
    expect(h.onRowsMock).not.toHaveBeenCalled();
  });

  it("stop() 後に届いた応答は onRows を呼ばない(unmount 後の setState 禁止と同じ考え方)", async () => {
    const pending = createDeferred<EditLockStatusRow[]>();
    h.fetchStatusMock.mockReturnValueOnce(pending.promise);
    const controller = createEditLockStatusController(h.deps);
    controller.start([P1]);
    await flush();

    controller.stop();
    expect(h.registry.activeCount()).toBe(0);

    pending.resolve([row("property", "p1")]);
    await flush();
    expect(h.onRowsMock).not.toHaveBeenCalled();
  });

  it("stop() すると以後の周期も止まる", async () => {
    h.fetchStatusMock.mockResolvedValue([]);
    const controller = createEditLockStatusController(h.deps);
    controller.start([P1]);
    await flush();
    controller.stop();

    h.fetchStatusMock.mockClear();
    await h.registry.fire();
    expect(h.fetchStatusMock).not.toHaveBeenCalled();
  });

  it("資源が0件のときは問い合わせず、空配列で onRows を呼ぶ", async () => {
    const controller = createEditLockStatusController(h.deps);
    controller.start([]);
    await flush();
    expect(h.fetchStatusMock).not.toHaveBeenCalled();
    expect(h.onRowsMock).toHaveBeenCalledWith([]);
  });

  it("複数チャンクの応答をまとめて1回の onRows にする", async () => {
    const resources: EditLockStatusResource[] = Array.from({ length: 51 }, (_, i) => ({
      resourceType: "owner" as const,
      resourceId: `o${i}`,
    }));
    h.fetchStatusMock
      .mockResolvedValueOnce(resources.slice(0, 50).map((r) => row("owner", r.resourceId)))
      .mockResolvedValueOnce(resources.slice(50).map((r) => row("owner", r.resourceId)));
    const controller = createEditLockStatusController(h.deps);
    controller.start(resources);
    await flush();

    expect(h.onRowsMock).toHaveBeenCalledTimes(1);
    expect(h.onRowsMock.mock.calls[0][0]).toHaveLength(51);
  });

  it("1回のfetchStatusが失敗しても、他のチャンクの結果は反映する(fail open)", async () => {
    const resources: EditLockStatusResource[] = Array.from({ length: 51 }, (_, i) => ({
      resourceType: "owner" as const,
      resourceId: `o${i}`,
    }));
    h.fetchStatusMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(resources.slice(50).map((r) => row("owner", r.resourceId)));
    const controller = createEditLockStatusController(h.deps);
    controller.start(resources);
    await flush();

    expect(h.onRowsMock).toHaveBeenCalledTimes(1);
    expect(h.onRowsMock.mock.calls[0][0]).toHaveLength(1);
  });
});

describe("findEditLockStatusRow", () => {
  it("resourceType・resourceIdが一致する行を返す", () => {
    const rows = [row("property", "p1"), row("owner", "o1", "held_by_other")];
    expect(findEditLockStatusRow(rows, "owner", "o1")).toEqual(row("owner", "o1", "held_by_other"));
  });

  it("一致する行が無ければ undefined", () => {
    expect(findEditLockStatusRow([row("property", "p1")], "owner", "o1")).toBeUndefined();
  });
});
