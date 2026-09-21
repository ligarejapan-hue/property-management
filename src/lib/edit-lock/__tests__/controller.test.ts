/**
 * 鍵を持つ側の司令塔(createEditLockController)を node で実挙動テストする。
 *
 * ⚠このリポジトリは jsdom も renderHook も使わない(vitest.config.ts が
 *   environment: "node" を固定)。判断もタイマーもこのファイルが唯一の主戦場で、
 *   `use-edit-lock.ts` は結線だけなので source assertion で足りる。
 *
 * `deps.setInterval` / `deps.clearInterval` は本物のタイマーを使わず、
 * このテストが持つ「登録簿」に差し替える。合図は登録された関数を手で1回呼んで
 * 発火させ、内部の `await` を挟む非同期処理は `flush()` でマイクロタスクを
 * 掃き出してから結果を見る(`vi.useFakeTimers` は使わない=deps に無い時計へ
 * 触れさせない設計を守るため)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEditLockController, type EditLockControllerDeps } from "../controller";
import type { AcquireResponse, HeartbeatResponse, EditLockUiState } from "../ui-state";
import { EDIT_LOCK_HEARTBEAT_INTERVAL_MS } from "../rules";

const LOCK_ID = "11111111-1111-4111-8111-111111111111";
const SINCE = "2026-09-22T01:00:00.000Z";

const MINE: AcquireResponse = { state: "mine", lockId: LOCK_ID, since: SINCE };
const HEARTBEAT_MINE: HeartbeatResponse = { state: "mine", idleSince: SINCE };
const HEARTBEAT_FORCE_RELEASED: HeartbeatResponse = { state: "lost", reason: "force_released" };
const HEARTBEAT_EXPIRED: HeartbeatResponse = { state: "lost", reason: "expired" };
const HEARTBEAT_DELETED: HeartbeatResponse = { notFound: true };

/** マイクロタスクを掃き出す(controller 内の await 1〜2段を進める)。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 手で解決タイミングを操るための Promise(応答の到着順を入れ替えるテスト用)。 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * `deps.setInterval`/`clearInterval` の偽物。登録簿(Map)を持ち、
 * `fire()` は今アクティブな間隔コールバックを1回だけ手で呼ぶ。
 */
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

interface Harness {
  deps: EditLockControllerDeps;
  acquireMock: ReturnType<typeof vi.fn>;
  heartbeatMock: ReturnType<typeof vi.fn>;
  releaseMock: ReturnType<typeof vi.fn>;
  releaseByBeaconMock: ReturnType<typeof vi.fn>;
  onStateMock: ReturnType<typeof vi.fn>;
  registry: ReturnType<typeof createIntervalRegistry>;
  lastState: () => EditLockUiState;
}

function createHarness(): Harness {
  const registry = createIntervalRegistry();
  const acquireMock = vi.fn<() => Promise<AcquireResponse>>();
  const heartbeatMock = vi.fn<(active: boolean) => Promise<HeartbeatResponse>>();
  const releaseMock = vi.fn<(lockId: string) => Promise<void>>().mockResolvedValue(undefined);
  const releaseByBeaconMock = vi.fn<(lockId: string) => void>();
  const onStateMock = vi.fn<(state: EditLockUiState, warnIdle: boolean) => void>();
  const deps: EditLockControllerDeps = {
    acquire: acquireMock,
    heartbeat: heartbeatMock,
    release: releaseMock,
    releaseByBeacon: releaseByBeaconMock,
    onState: onStateMock,
    now: () => new Date(SINCE).getTime(),
    setInterval: registry.setInterval,
    clearInterval: registry.clearInterval,
  };
  return {
    deps,
    acquireMock,
    heartbeatMock,
    releaseMock,
    releaseByBeaconMock,
    onStateMock,
    registry,
    lastState: () => onStateMock.mock.calls.at(-1)?.[0] as EditLockUiState,
  };
}

describe("createEditLockController", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it("1) 取得してから30秒ごと(定数どおり)に合図を送る", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);

    await controller.acquire();
    expect(h.lastState().kind).toBe("mine");
    expect(h.registry.setIntervalCalls).toEqual([{ ms: EDIT_LOCK_HEARTBEAT_INTERVAL_MS }]);
    expect(h.heartbeatMock).not.toHaveBeenCalled();

    await h.registry.fire();
    expect(h.heartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("2) 操作があった回の合図は active=true、次は false に戻る", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    controller.noteActivity();
    await h.registry.fire();
    expect(h.heartbeatMock.mock.calls[0][0]).toBe(true);

    await h.registry.fire();
    expect(h.heartbeatMock.mock.calls[1][0]).toBe(false);
  });

  it("3) 管理者に外されたら合図は止まり、入力しても取り直さない", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_FORCE_RELEASED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    expect(h.registry.activeCount()).toBe(1);

    await h.registry.fire();
    expect(h.lastState().kind).toBe("force_released");
    expect(h.registry.activeCount()).toBe(0);

    h.acquireMock.mockClear();
    controller.noteActivity();
    await flush();
    expect(h.acquireMock).not.toHaveBeenCalled();
  });

  it("4) 期限切れは合図が止まり、入力した時に1回だけ取り直す", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");
    expect(h.registry.activeCount()).toBe(0);

    h.acquireMock.mockClear();
    h.acquireMock.mockResolvedValue(MINE);
    controller.noteActivity();
    await flush();
    expect(h.acquireMock).toHaveBeenCalledTimes(1);
    expect(h.lastState().kind).toBe("mine");
    // 取り直した後は合図が再開している(新しい間隔が1本だけ)。
    expect(h.registry.activeCount()).toBe(1);
  });

  it("5) 資源が消えたら合図を完全に止める(無限ループにしない)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_DELETED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    await h.registry.fire();
    expect(h.lastState().kind).toBe("deleted");
    expect(h.registry.activeCount()).toBe(0);
    expect(h.registry.clearInterval).toHaveBeenCalledTimes(1);

    h.heartbeatMock.mockClear();
    await h.registry.fire();
    expect(h.heartbeatMock).not.toHaveBeenCalled();
  });

  it("6) release() を呼ぶと鍵を返し、合図も止まる", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    expect(h.registry.activeCount()).toBe(1);

    await controller.release();
    expect(h.releaseMock).toHaveBeenCalledWith(LOCK_ID);
    expect(h.lastState().kind).toBe("idle");
    expect(h.registry.activeCount()).toBe(0);

    h.heartbeatMock.mockClear();
    await h.registry.fire();
    expect(h.heartbeatMock).not.toHaveBeenCalled();
  });

  it("7) 画面が閉じるとき(onHidden)は beacon で解除する", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    controller.onHidden();
    expect(h.releaseByBeaconMock).toHaveBeenCalledTimes(1);
    expect(h.releaseByBeaconMock).toHaveBeenCalledWith(LOCK_ID);
  });

  it("8) 裏から戻ったら(onVisible)即座に1回だけ合図を送る", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    h.heartbeatMock.mockClear();

    controller.onVisible();
    await flush();
    expect(h.heartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("鍵を持っていない間は onVisible が合図を送らない(閲覧中のタブまで叩かない)", async () => {
    const controller = createEditLockController(h.deps);
    controller.onVisible();
    await flush();
    expect(h.heartbeatMock).not.toHaveBeenCalled();
  });

  it("dispose() すると合図が止まり、以後 onState も呼ばれない(unmount 後の setState 禁止)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    h.onStateMock.mockClear();

    controller.dispose();
    expect(h.registry.activeCount()).toBe(0);

    // dispose 後に acquire が遅れて解決しても onState は呼ばれない。
    h.acquireMock.mockResolvedValue(MINE);
    await controller.acquire();
    expect(h.onStateMock).not.toHaveBeenCalled();
  });

  // review round1 で指摘された非同期の穴(C1/I1/I2/I4/m2/m3)。

  it("C1a) release中に届いた古い合図の mine 応答は反映しない(release後もidleのまま)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const pendingHeartbeat = createDeferred<HeartbeatResponse>();
    h.heartbeatMock.mockReturnValue(pendingHeartbeat.promise);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    // 合図を1回発火する(応答はまだ来ない=in-flight のまま)。
    await h.registry.fire();
    expect(h.heartbeatMock).toHaveBeenCalledTimes(1);

    // その合図の応答が届く前に release する。
    await controller.release();
    expect(h.releaseMock).toHaveBeenCalledWith(LOCK_ID);
    expect(h.lastState().kind).toBe("idle");
    const onStateCallsAfterRelease = h.onStateMock.mock.calls.length;

    // 遅れて mine の応答が届いても、release 後の idle を mine に戻さない。
    pendingHeartbeat.resolve(HEARTBEAT_MINE);
    await flush();
    expect(h.lastState().kind).toBe("idle");
    expect(h.onStateMock.mock.calls.length).toBe(onStateCallsAfterRelease);
    expect(h.registry.activeCount()).toBe(0);
  });

  it("C1b) 出遅れた合図の mine 応答が、先に届いた喪失判定を上書きしない(二重発火)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const older = createDeferred<HeartbeatResponse>();
    const newer = createDeferred<HeartbeatResponse>();
    h.heartbeatMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    // interval の合図(1回目=older)を発火。応答はまだ来ない。
    await h.registry.fire();
    // 裏から戻った合図(2回目=newer)がまだ mine のうちに発行される。
    controller.onVisible();
    await flush();
    expect(h.heartbeatMock).toHaveBeenCalledTimes(2);

    // 新しい方(newer)の応答が先に届き、喪失と判定される。
    newer.resolve(HEARTBEAT_EXPIRED);
    await flush();
    expect(h.lastState().kind).toBe("expired");
    expect(h.registry.activeCount()).toBe(0);

    // 古い方(older)の mine 応答が遅れて届いても、喪失判定を上書きしない。
    older.resolve(HEARTBEAT_MINE);
    await flush();
    expect(h.lastState().kind).toBe("expired");
  });

  it("I1a) 合図が失敗しても状態は変わらず、間隔も止まらない(一過性として無視する)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockRejectedValueOnce(new Error("network down"));
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    const onStateCallsAfterAcquire = h.onStateMock.mock.calls.length;

    await h.registry.fire();
    expect(h.onStateMock.mock.calls.length).toBe(onStateCallsAfterAcquire);
    expect(h.registry.activeCount()).toBe(1);
  });

  it("I1b) awaitしたacquireの失敗は呼び出し元にそのまま届く", async () => {
    h.acquireMock.mockRejectedValueOnce(new Error("EDIT_SCREEN_REQUIRED"));
    const controller = createEditLockController(h.deps);

    await expect(controller.acquire()).rejects.toThrow("EDIT_SCREEN_REQUIRED");
  });

  it("I1c) 期限切れの取り直し(fire-and-forget)が失敗しても外へ投げず、expiredのまま留まる", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    h.acquireMock.mockRejectedValueOnce(new Error("network down"));
    expect(() => controller.noteActivity()).not.toThrow();
    await flush();
    expect(h.lastState().kind).toBe("expired");
  });

  it("I2a) noteSaveError: EDIT_LOCK_STALE は expired にし、合図も止める", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    expect(h.registry.activeCount()).toBe(1);

    controller.noteSaveError("EDIT_LOCK_STALE", null);
    expect(h.lastState().kind).toBe("expired");
    expect(h.registry.activeCount()).toBe(0);
  });

  it("I2b) noteSaveError: EDIT_LOCK_FORCE_RELEASED は force_released にする", () => {
    const controller = createEditLockController(h.deps);
    controller.noteSaveError("EDIT_LOCK_FORCE_RELEASED", null);
    expect(h.lastState().kind).toBe("force_released");
  });

  it("I2c) noteSaveError: EDIT_LOCKED は保持者名つきの taken にする", () => {
    const controller = createEditLockController(h.deps);
    controller.noteSaveError("EDIT_LOCKED", "山田");
    expect(h.lastState()).toMatchObject({ kind: "taken", holderName: "山田" });
  });

  it("I2d) noteSaveError: 鍵と無関係なコードは状態を変えない(onStateも呼ばない)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    const callsBefore = h.onStateMock.mock.calls.length;

    controller.noteSaveError("CONFLICT", null);
    expect(h.onStateMock.mock.calls.length).toBe(callsBefore);
    expect(h.lastState().kind).toBe("mine");
  });

  it("I4) 423(他の人が持っている)でacquireが返ったら合図を始めない", async () => {
    const held: AcquireResponse = {
      code: "EDIT_LOCKED",
      state: "held_by_other",
      holderName: "山田",
      since: SINCE,
    };
    h.acquireMock.mockResolvedValue(held);
    const controller = createEditLockController(h.deps);

    await controller.acquire();
    expect(h.lastState().kind).toBe("taken");
    expect(h.registry.activeCount()).toBe(0);
    expect(h.heartbeatMock).not.toHaveBeenCalled();
  });

  it("m2) 鍵を持っていない間はonHiddenが何もしない(beaconを送らない)", () => {
    const controller = createEditLockController(h.deps);
    controller.onHidden();
    expect(h.releaseByBeaconMock).not.toHaveBeenCalled();
  });

  it("m3) 期限切れの取り直しは、直前の入力をactiveとして次の合図で報告する", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    // noteActivity が activeSinceLastBeat=true をセットしてから取り直す。
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_MINE);
    controller.noteActivity();
    await flush();
    expect(h.lastState().kind).toBe("mine");

    // 取り直しの引き金になった入力が、次の最初の合図で active=true として報告される。
    await h.registry.fire();
    expect(h.heartbeatMock.mock.calls.at(-1)?.[0]).toBe(true);
  });

  // review round2 で指摘された残りの穴(n1/n2/n3)。

  it("n1a) acquire中にrelease()が追い越しても、後から届いたmineの許可を孤児にせずbeaconで手放す", async () => {
    const pendingAcquire = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(pendingAcquire.promise);
    const controller = createEditLockController(h.deps);

    // acquire がまだ応答待ちの間に release() が先に走る(lockId はまだ null なので
    // deps.release は呼ばれない=これが「discard するだけでは孤児になる」原因)。
    const acquirePromise = controller.acquire();
    await controller.release();
    expect(h.releaseMock).not.toHaveBeenCalled();

    // サーバが遅れて許可(mine)を返す。
    pendingAcquire.resolve(MINE);
    await acquirePromise;
    await flush();

    // state には今さら反映しない(discard は正しいまま)。
    expect(h.lastState().kind).toBe("idle");
    // しかしサーバが実際に許可した lockId は孤児にしない=beacon で手放す。
    expect(h.releaseByBeaconMock).toHaveBeenCalledWith(LOCK_ID);
    expect(h.registry.activeCount()).toBe(0);
  });

  it("n1b) unmountの後始末(onHidden→dispose)がacquireを追い越しても、後から届いたmineをbeaconで手放す", async () => {
    const pendingAcquire = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(pendingAcquire.promise);
    const controller = createEditLockController(h.deps);

    const acquirePromise = controller.acquire();
    // use-edit-lock.ts のcleanupと同じ順序。lockIdがまだnullなのでonHiddenはこの時点では何もしない。
    controller.onHidden();
    controller.dispose();
    expect(h.releaseByBeaconMock).not.toHaveBeenCalled();

    pendingAcquire.resolve(MINE);
    await acquirePromise;
    await flush();

    // dispose済みなのでonStateは呼ばれない(既存の契約)が、beaconでの解放は行う。
    expect(h.onStateMock).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "mine" }), expect.anything());
    expect(h.releaseByBeaconMock).toHaveBeenCalledWith(LOCK_ID);
    expect(h.registry.activeCount()).toBe(0);
  });

  it("n2) 期限切れの取り直しが404(資源消失)で失敗したら deleted にし、以後は取り直さない", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    h.acquireMock.mockRejectedValueOnce(Object.assign(new Error("物件が見つかりません"), { code: "NOT_FOUND" }));
    controller.noteActivity();
    await flush();
    expect(h.lastState().kind).toBe("deleted");

    // deleted になった後は、入力してももう取り直しを試みない(黙って何度も404を叩かない)。
    h.acquireMock.mockClear();
    controller.noteActivity();
    await flush();
    expect(h.acquireMock).not.toHaveBeenCalled();
  });

  it("n2b) 404以外の失敗(ネットワーク瞬断等)では従来どおり無視し、expiredのまま次の入力でまた試みる", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    h.acquireMock.mockRejectedValueOnce(new Error("network down"));
    controller.noteActivity();
    await flush();
    expect(h.lastState().kind).toBe("expired"); // deleted にはならない

    h.acquireMock.mockResolvedValueOnce(MINE);
    controller.noteActivity();
    await flush();
    expect(h.lastState().kind).toBe("mine"); // 次の入力でまた試みられる
  });

  it("n3) 合図が失敗しても、直前の入力(active)は次の合図まで持ち越す", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    controller.noteActivity();
    h.heartbeatMock.mockRejectedValueOnce(new Error("network down"));
    await h.registry.fire();

    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_MINE);
    await h.registry.fire();
    expect(h.heartbeatMock.mock.calls.at(-1)?.[0]).toBe(true);
  });

  it("n3b) 失敗した合図の直後に新しい入力があっても、その入力を消さない", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    h.heartbeatMock.mockRejectedValueOnce(new Error("network down"));
    await h.registry.fire(); // active=false のまま失敗(入力なし)
    controller.noteActivity(); // 失敗の直後に入力

    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_MINE);
    await h.registry.fire();
    expect(h.heartbeatMock.mock.calls.at(-1)?.[0]).toBe(true);
  });
});
