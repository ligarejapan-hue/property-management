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

/** 手で解決/拒否のタイミングを操る Promise(応答の到着順を入れ替えるテスト用)。 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  /**
   * 全ブランチ横断レビュー C1(兄弟 `status-controller.ts` の start-after-stop の鏡像)。
   *
   * `use-edit-lock.ts` の `[controller]` effect は cleanup で `onHidden(); dispose();` を
   * 呼ぶが、React StrictMode は effect を mount→cleanup→mount と二重に呼び、
   * **`useMemo` は effect の再実行では作り直されない**ため、2回目の mount は
   * **すでに dispose 済みの同じインスタンス**を掴む。`revive()` が無いと、その後の
   * `acquire()` はサーバが許可した鍵を捨てて beacon で返し、`state` は `idle` のまま
   * =帯も通知も出ないのに保存ボタンだけが永久に無効になる(開発環境で必ず踏む)。
   */
  it("dispose() の後に revive() すれば、また鍵を取って合図も再開する(横断レビューC1・StrictModeのeffect二重呼び出し)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    // hook の cleanup と同じ順序(beacon で手放してから破棄する)。
    controller.onHidden();
    controller.dispose();
    expect(h.registry.activeCount()).toBe(0);

    h.onStateMock.mockClear();
    h.acquireMock.mockClear();
    h.heartbeatMock.mockClear();
    h.releaseByBeaconMock.mockClear();

    // ⚠修理前はここで `disposed` が戻らず、取得の応答は捨てられて beacon で即返され、
    //   `onState` は一度も呼ばれない(=保存ボタンが永久に押せない)。
    controller.revive();
    await controller.acquire();

    expect(h.acquireMock).toHaveBeenCalledTimes(1);
    expect(h.lastState()).toMatchObject({ kind: "mine", lockId: LOCK_ID });
    // 許可された鍵を孤児として beacon で捨てていない(=本当に掴み直している)。
    expect(h.releaseByBeaconMock).not.toHaveBeenCalled();
    // 合図も1本だけ生きている。
    expect(h.registry.activeCount()).toBe(1);
    await h.registry.fire();
    expect(h.heartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("revive() は dispose() を取り消すだけで、鍵を勝手に取り直さない(effectの先頭で呼んでも窓口の呼び出しを増やさない)", async () => {
    const controller = createEditLockController(h.deps);
    controller.dispose();
    h.onStateMock.mockClear();

    controller.revive();

    expect(h.acquireMock).not.toHaveBeenCalled();
    expect(h.heartbeatMock).not.toHaveBeenCalled();
    expect(h.onStateMock).not.toHaveBeenCalled();
    expect(h.registry.activeCount()).toBe(0);
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

  /**
   * 仕上げround2の裁定。保存の423は氏名を持たないので、まず既定の文言で帯を出し
   * (即座)、状態窓口の問い合わせが保持者を名乗れたら**帯の氏名だけを差し替える**。
   * これが無いと、エラー表示が「佐藤さんが編集中です(14:02〜)」と言っているすぐ上の
   * 帯が「他の利用者さんが編集を始めました」と言い続ける(この機能の存在理由である
   * 「誰が編集しているか」に画面が2つの違う答えを出す)。
   */
  it("R2a) noteSaveErrorHolder: takenの間は帯の氏名と開始時刻を実名へ差し替える", () => {
    const since = "2026-09-22T05:02:00.000Z";
    const controller = createEditLockController(h.deps);
    controller.noteSaveError("EDIT_LOCKED", null);
    expect(h.lastState()).toMatchObject({ kind: "taken", holderName: "他の利用者" });

    controller.noteSaveErrorHolder("佐藤", since);
    expect(h.lastState()).toMatchObject({ kind: "taken", holderName: "佐藤", since });
  });

  it("R2b) noteSaveErrorHolder: 状態が taken から動いていたら何もしない(古い組み立てで帯を戻さない)", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    controller.noteSaveError("EDIT_LOCKED", null);

    // 問い合わせが届く前に取り直せた(または閉じた)=もう taken ではない。
    await controller.acquire();
    expect(h.lastState().kind).toBe("mine");
    const callsBefore = h.onStateMock.mock.calls.length;

    controller.noteSaveErrorHolder("佐藤", "2026-09-22T05:02:00.000Z");
    expect(h.onStateMock.mock.calls.length).toBe(callsBefore);
    expect(h.lastState().kind).toBe("mine");
  });

  it("R2c) noteSaveErrorHolder: dispose 後は onState を呼ばない(unmount後のsetState禁止)", () => {
    const controller = createEditLockController(h.deps);
    controller.noteSaveError("EDIT_LOCKED", null);
    controller.dispose();
    h.onStateMock.mockClear();

    controller.noteSaveErrorHolder("佐藤", "2026-09-22T05:02:00.000Z");
    expect(h.onStateMock).not.toHaveBeenCalled();
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

    // dispose済みなのでonStateは一度も呼ばれない(既存の契約)が、beaconでの解放は行う。
    expect(h.onStateMock).not.toHaveBeenCalled();
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

  // review round3 の残り(n7/n8)。

  it("n7) 期限切れの間の連続入力(バースト)は、acquireを1回しか飛ばさない", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    h.acquireMock.mockClear();
    const pending = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(pending.promise);

    // 素早い3回の入力(バースト)。1回目の応答がまだ返っていない。
    controller.noteActivity();
    controller.noteActivity();
    controller.noteActivity();
    await flush();
    expect(h.acquireMock).toHaveBeenCalledTimes(1);

    // 1回目の応答が届く。
    pending.resolve(MINE);
    await flush();
    expect(h.lastState().kind).toBe("mine");

    // ガードは in-flight の間だけ(finally で必ず解除される)。次に期限切れになった
    // ときにまた1回だけ取得できることを確かめる(永久に塞がらない)。
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    h.acquireMock.mockClear();
    h.acquireMock.mockResolvedValueOnce(MINE);
    controller.noteActivity();
    await flush();
    expect(h.acquireMock).toHaveBeenCalledTimes(1);
    expect(h.lastState().kind).toBe("mine");
  });

  it("n8) 取り直しの間に世代が動いていたら、遅れて届いた404(資源消失)は無視する(他の書き込み経路と同じ規約)", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    const pendingAcquire = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(pendingAcquire.promise);
    controller.noteActivity(); // 404で失敗する取り直しを開始(まだ未解決)。

    // 応答を待つ間に、別の出来事(release)が世代を進める。
    await controller.release();
    expect(h.lastState().kind).toBe("idle");
    const onStateCallsAfterRelease = h.onStateMock.mock.calls.length;

    // 遅れて404(資源消失)の応答が届く。世代がずれているので反映しない。
    pendingAcquire.reject(Object.assign(new Error("物件が見つかりません"), { code: "NOT_FOUND" }));
    await flush();

    expect(h.lastState().kind).toBe("idle"); // deleted にはならない
    expect(h.onStateMock.mock.calls.length).toBe(onStateCallsAfterRelease); // onStateは増えない
  });

  // task 5 に持ち越された2件(review of task 3)。

  it("t5a) 取得が既に飛んでいる間の acquire() は同じ Promise を返す(何も送らず空で解決しない)", async () => {
    const pending = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(pending.promise);
    const controller = createEditLockController(h.deps);

    const first = controller.acquire();
    const second = controller.acquire();
    expect(h.acquireMock).toHaveBeenCalledTimes(1); // 新しい取得は飛ばさない(従来どおり)

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await flush();
    // ⚠修理前はここで true になっていた(何も送っていないのに完了したことになるバグ)。
    expect(secondSettled).toBe(false);

    pending.resolve(MINE);
    await first;
    await second;
    expect(secondSettled).toBe(true);
    expect(h.lastState().kind).toBe("mine");
  });

  it("t5b) 飛んでいる間に来た入力が一過性の理由で失敗しても、決着後に新しい入力を待たずもう一度だけ取り直す", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE);
    h.heartbeatMock.mockResolvedValueOnce(HEARTBEAT_EXPIRED);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    await h.registry.fire();
    expect(h.lastState().kind).toBe("expired");

    h.acquireMock.mockClear();
    const pending = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(pending.promise);
    controller.noteActivity(); // 1回目の取り直しを開始(まだ未解決)
    await flush();
    expect(h.acquireMock).toHaveBeenCalledTimes(1);

    controller.noteActivity(); // 飛んでいる間のもう1回の入力(修理前はここで黙って捨てられ、以後二度と取り直されなかった)
    await flush();
    expect(h.acquireMock).toHaveBeenCalledTimes(1); // まだ2本目は飛ばさない(n7の直列化を維持)

    // 1回目の試行がネットワーク瞬断等の一過性の理由で失敗する(NOT_FOUNDではない)。
    h.acquireMock.mockResolvedValueOnce(MINE);
    pending.reject(new Error("network down"));
    await flush();

    // 新しい入力(3回目のnoteActivity)を待たずに、結着後に自動でもう一度だけ取り直している。
    expect(h.acquireMock).toHaveBeenCalledTimes(2);
    expect(h.lastState().kind).toBe("mine");
  });

  it("t5c) deps.acquire()が同期的に投げても、以後のacquire()が同じ失敗を返し続けて塞がらない", async () => {
    // ⚠(task5 review round1 minor) 従来の実装は、この同期的な throw が
    //   `acquireInFlightPromise = null` への代入(finally内)を、
    //   `acquireInFlightPromise = (async () => {...})()` という外側の代入より
    //   先に実行してしまい、その直後に外側の代入がそれを上書きして
    //   `acquireInFlightPromise` を「決着済みの拒否済み Promise」に永久に固定していた。
    h.acquireMock.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });
    const controller = createEditLockController(h.deps);

    await expect(controller.acquire()).rejects.toThrow("sync boom");

    // ⚠塞がっていたら、この2回目の acquire() も同じ古い拒否済み Promise を返すだけで
    //   deps.acquire() が呼ばれず、MINE には決してならない。
    h.acquireMock.mockResolvedValueOnce(MINE);
    await controller.acquire();
    expect(h.lastState().kind).toBe("mine");
  });

  /**
   * 外部レビュー@codex P2(2026-09-26)。StrictMode の effect 二重呼び出し
   * (setup→cleanup→setup)が、1回目の取得の**応答待ちの最中**に起きる場合。
   * cleanup の dispose() で世代が進むので1回目の応答は「古い」として捨てられ
   * beacon で返される。2回目の setup の acquire() がその古い試行へ**合流**すると、
   * 約束は成功で終わるのに state は idle のまま=所有者カードの保存ボタンが永久に押せない。
   */
  const SECOND_LOCK_ID = "22222222-2222-4222-8222-222222222222";
  const SECOND_MINE: AcquireResponse = { state: "mine", lockId: SECOND_LOCK_ID, since: SINCE };

  it("s1) 取得の応答待ちの間に dispose→revive されたら、後の acquire() は古い試行に合流せず取り直す(StrictMode)", async () => {
    const stale = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(SECOND_MINE);
    h.heartbeatMock.mockResolvedValue(HEARTBEAT_MINE);
    const controller = createEditLockController(h.deps);

    const first = controller.acquire();
    // use-edit-lock.ts の cleanup → 2回目の setup と同じ順序。
    controller.onHidden();
    controller.dispose();
    controller.revive();
    const second = controller.acquire();

    stale.resolve(MINE);
    await first;
    await second;
    await flush();

    // 古い試行の許可は孤児にせず beacon で返し、新しく取り直した鍵を持っている。
    expect(h.releaseByBeaconMock).toHaveBeenCalledWith(LOCK_ID);
    expect(h.acquireMock).toHaveBeenCalledTimes(2);
    expect(h.lastState()).toMatchObject({ kind: "mine", lockId: SECOND_LOCK_ID });
    expect(h.registry.activeCount()).toBe(1);
  });

  it("s2) 古い試行が失敗しても、後の acquire() は取り直した結果で決着する", async () => {
    const stale = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(SECOND_MINE);
    const controller = createEditLockController(h.deps);

    const first = controller.acquire();
    controller.dispose();
    controller.revive();
    const second = controller.acquire();

    stale.reject(new Error("network"));
    await expect(first).rejects.toThrow("network");
    await second;

    expect(h.acquireMock).toHaveBeenCalledTimes(2);
    expect(h.lastState()).toMatchObject({ kind: "mine", lockId: SECOND_LOCK_ID });
  });

  it("s3) 古い試行の決着を待つ間に再び dispose されたら、取り直しを送らない(unmount後に鍵を作らない)", async () => {
    const stale = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(SECOND_MINE);
    const controller = createEditLockController(h.deps);

    const first = controller.acquire();
    controller.dispose();
    controller.revive();
    const second = controller.acquire();
    controller.dispose();

    stale.resolve(MINE);
    await first;
    await second;
    await flush();

    expect(h.acquireMock).toHaveBeenCalledTimes(1);
    expect(h.onStateMock).not.toHaveBeenCalled();
  });

  it("s4) 古い試行を待つ間の acquire() が何本来ても、取り直しは1本だけ(n7の直列化を保つ)", async () => {
    const stale = createDeferred<AcquireResponse>();
    h.acquireMock.mockReturnValueOnce(stale.promise).mockResolvedValue(SECOND_MINE);
    const controller = createEditLockController(h.deps);

    const first = controller.acquire();
    controller.dispose();
    controller.revive();
    const a = controller.acquire();
    const b = controller.acquire();

    stale.resolve(MINE);
    await Promise.all([first, a, b]);
    await flush();

    expect(h.acquireMock).toHaveBeenCalledTimes(2);
    expect(h.lastState()).toMatchObject({ kind: "mine", lockId: SECOND_LOCK_ID });
  });

  /**
   * 外部レビュー@codex P2(2026-09-26 round5)。bfcache(戻る/進むの保存)では pagehide が
   * 来ても unmount されない。beacon で鍵を返したのに画面が `mine` のままだと、復元後に
   * 保存ボタンが押せて返したはずの lockId を送り EDIT_LOCK_STALE、しかも `mine` の間は
   * 入力しても取り直さない。
   */
  it("b1) onPageHide: 鍵を持っていれば beacon で返し、画面も expired に落として合図を止める", async () => {
    h.acquireMock.mockResolvedValue(MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();

    controller.onPageHide();

    expect(h.releaseByBeaconMock).toHaveBeenCalledWith(LOCK_ID);
    expect(h.lastState()).toEqual({ kind: "expired" });
    expect(h.registry.activeCount()).toBe(0);
  });

  it("b2) onPageHide の後に bfcache から戻ったら(persisted)、入力を待たずに取り直す", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE).mockResolvedValueOnce(SECOND_MINE);
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    controller.onPageHide();

    controller.onPageShow(true);
    await flush();

    expect(h.acquireMock).toHaveBeenCalledTimes(2);
    expect(h.lastState()).toMatchObject({ kind: "mine", lockId: SECOND_LOCK_ID });
    expect(h.registry.activeCount()).toBe(1);
  });

  it("b3) 通常の読み込み(persisted=false)や、鍵を持っていない間の pageshow では何もしない", async () => {
    const controller = createEditLockController(h.deps);
    controller.onPageShow(false);
    controller.onPageShow(true);
    controller.onPageHide();
    await flush();

    expect(h.acquireMock).not.toHaveBeenCalled();
    expect(h.releaseByBeaconMock).not.toHaveBeenCalled();
    expect(h.onStateMock).not.toHaveBeenCalled();
  });

  it("b4) 取り直しに失敗しても外へ投げず expired のまま(次の入力でまた試みる)", async () => {
    h.acquireMock.mockResolvedValueOnce(MINE).mockRejectedValueOnce(new Error("network"));
    const controller = createEditLockController(h.deps);
    await controller.acquire();
    controller.onPageHide();

    controller.onPageShow(true);
    await flush();

    expect(h.lastState()).toEqual({ kind: "expired" });
    h.acquireMock.mockResolvedValueOnce(SECOND_MINE);
    controller.noteActivity();
    await flush();
    expect(h.lastState()).toMatchObject({ kind: "mine", lockId: SECOND_LOCK_ID });
  });
});
