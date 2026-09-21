/**
 * 鍵を持つ側の司令塔(仕様 6.2)。**判断は一切ここでしない**。
 * すべて `ui-state.ts` の純関数(`uiStateFromAcquire` 等)に委ね、この
 * ファイルは「窓口を呼ぶ順序」「30秒ごとの合図」「イベントの配線」だけを持つ。
 *
 * React には依存しない(タイマー・時計・窓口を `deps` として注入する)。
 * `use-edit-lock.ts` はこれを React に結線するだけの薄い層になる。
 *
 * ⚠(review round1 C1) 合図は複数が同時に飛びうる(30秒間隔のtickと、裏から戻った
 *   ときの即時合図が重なる/releaseと入れ違う)。届いた順は保証されないので、
 *   `generation` を持ち、acquire/release/dispose の開始時と非mine状態への遷移時に
 *   必ず1つ進める。合図・取得を投げる直前に値を捕まえ、応答が返ったときに値が
 *   変わっていたら(=その間に鍵の持ち主が変わった/失われた/手放された)反映しない。
 *   `src/lib/address-lookup-ui-utils.ts` の `seq`(stale request 破棄)と同じ考え方。
 */
import {
  shouldReacquireOnInput,
  shouldWarnIdle,
  uiStateFromAcquire,
  uiStateFromHeartbeat,
  uiStateFromSaveError,
  type AcquireResponse,
  type EditLockUiState,
  type HeartbeatResponse,
} from "./ui-state";
import { EDIT_LOCK_HEARTBEAT_INTERVAL_MS } from "./rules";

export interface EditLockControllerDeps {
  acquire(): Promise<AcquireResponse>;
  heartbeat(active: boolean): Promise<HeartbeatResponse>;
  release(lockId: string): Promise<void>;
  releaseByBeacon(lockId: string): void;
  /** 状態が変わったら呼ばれる(hook は setState を渡す)。 */
  onState(state: EditLockUiState, warnIdle: boolean): void;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface EditLockController {
  acquire(): Promise<void>;
  release(): Promise<void>;
  noteActivity(): void;
  noteSaveError(code: string | null, holderName?: string | null): void;
  /** pagehide 相当。 */
  onHidden(): void;
  /** visibilitychange(表示に戻った)相当。 */
  onVisible(): void;
  dispose(): void;
}

export function createEditLockController(deps: EditLockControllerDeps): EditLockController {
  let state: EditLockUiState = { kind: "idle" };
  let lockId: string | null = null;
  let timerHandle: unknown = null;
  /** 前回の合図からの間に操作(noteActivity)があったか。合図のたびに false へ戻す。 */
  let activeSinceLastBeat = false;
  /** dispose 後は、遅れて解決した Promise の結果を一切反映しない。 */
  let disposed = false;
  /**
   * 「今の鍵の在任期」を表す世代番号。acquire/release/dispose の開始時と、非mine状態
   * (=喪失・解除・削除)への遷移のたびに進める。合図/取得はこれを投げる前に捕まえ、
   * 応答時に値がずれていたら(在任期が変わった)結果を捨てる。
   */
  let generation = 0;

  function bumpGeneration(): void {
    generation += 1;
  }

  function stopHeartbeat(): void {
    if (timerHandle !== null) {
      deps.clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    timerHandle = deps.setInterval(() => {
      void beat();
    }, EDIT_LOCK_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 状態を確定し、hook へ伝える。⚠鍵を失った状態(mine 以外)になったら合図を止め、
   * 世代を進める(=このタイミングより前に投げた合図/取得の応答は、後で届いても捨てる)。
   */
  function apply(next: EditLockUiState): void {
    state = next;
    lockId = next.kind === "mine" ? next.lockId : null;
    if (next.kind !== "mine") {
      stopHeartbeat();
      bumpGeneration();
    }
    if (disposed) return;
    deps.onState(next, shouldWarnIdle(next, deps.now()));
  }

  async function beat(): Promise<void> {
    if (disposed || lockId === null) return;
    const gen = generation;
    const active = activeSinceLastBeat;
    activeSinceLastBeat = false;
    const currentLockId = lockId;
    let res: HeartbeatResponse;
    try {
      res = await deps.heartbeat(active);
    } catch {
      // ⚠(review round1 I1) 合図の失敗はネットワーク瞬断等の一過性として扱う。
      //   状態は変えず、間隔も止めない(サーバ側の鍵は無操作が続けば自然に期限切れになる)。
      return;
    }
    // ⚠(review round1 C1) 応答が届くまでの間に release/dispose/別の合図の喪失判定が
    //   先に世代を進めていたら、この応答はもう「今の鍵」の話ではない=反映しない。
    if (disposed || gen !== generation) return;
    apply(uiStateFromHeartbeat(res, currentLockId));
  }

  async function acquire(): Promise<void> {
    bumpGeneration();
    const gen = generation;
    const res = await deps.acquire();
    if (disposed || gen !== generation) return;
    apply(uiStateFromAcquire(res));
    if (state.kind === "mine") startHeartbeat();
  }

  async function release(): Promise<void> {
    const idToRelease = lockId;
    bumpGeneration();
    stopHeartbeat();
    apply({ kind: "idle" });
    if (idToRelease) await deps.release(idToRelease);
  }

  /**
   * 入力・キー・ポインタのときに呼ぶ。期限切れならここで取り直す(管理者解除/削除はしない)。
   * ⚠(review round1 I1) 取り直しは fire-and-forget なので、失敗しても外へ投げない
   *   (次の入力でまた試みる。state は expired のまま留まる)。
   */
  function noteActivity(): void {
    activeSinceLastBeat = true;
    if (shouldReacquireOnInput(state)) {
      acquire().catch(() => {
        /* 一過性として無視。次の noteActivity で再試行される。 */
      });
    }
  }

  function noteSaveError(code: string | null, holderName: string | null = null): void {
    const next = uiStateFromSaveError(code, holderName);
    if (next) apply(next);
  }

  function onHidden(): void {
    if (lockId) deps.releaseByBeacon(lockId);
  }

  function onVisible(): void {
    if (state.kind === "mine") void beat();
  }

  function dispose(): void {
    disposed = true;
    bumpGeneration();
    stopHeartbeat();
  }

  return { acquire, release, noteActivity, noteSaveError, onHidden, onVisible, dispose };
}
