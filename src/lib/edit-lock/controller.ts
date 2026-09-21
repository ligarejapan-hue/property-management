/**
 * 鍵を持つ側の司令塔(仕様 6.2)。**判断は一切ここでしない**。
 * すべて `ui-state.ts` の純関数(`uiStateFromAcquire` 等)に委ね、この
 * ファイルは「窓口を呼ぶ順序」「30秒ごとの合図」「イベントの配線」だけを持つ。
 *
 * React には依存しない(タイマー・時計・窓口を `deps` として注入する)。
 * `use-edit-lock.ts` はこれを React に結線するだけの薄い層になる。
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

  /** 状態を確定し、hook へ伝える。⚠鍵を失った状態(mine 以外)になったら合図を止める。 */
  function apply(next: EditLockUiState): void {
    state = next;
    lockId = next.kind === "mine" ? next.lockId : null;
    if (next.kind !== "mine") stopHeartbeat();
    if (disposed) return;
    deps.onState(next, shouldWarnIdle(next, deps.now()));
  }

  async function beat(): Promise<void> {
    if (disposed || lockId === null) return;
    const active = activeSinceLastBeat;
    activeSinceLastBeat = false;
    const currentLockId = lockId;
    const res = await deps.heartbeat(active);
    if (disposed) return;
    apply(uiStateFromHeartbeat(res, currentLockId));
  }

  async function acquire(): Promise<void> {
    const res = await deps.acquire();
    if (disposed) return;
    activeSinceLastBeat = false;
    apply(uiStateFromAcquire(res));
    if (state.kind === "mine") startHeartbeat();
  }

  async function release(): Promise<void> {
    const idToRelease = lockId;
    stopHeartbeat();
    apply({ kind: "idle" });
    if (idToRelease) await deps.release(idToRelease);
  }

  /** 入力・キー・ポインタのときに呼ぶ。期限切れならここで取り直す(管理者解除/削除はしない)。 */
  function noteActivity(): void {
    activeSinceLastBeat = true;
    if (shouldReacquireOnInput(state)) void acquire();
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
    stopHeartbeat();
  }

  return { acquire, release, noteActivity, noteSaveError, onHidden, onVisible, dispose };
}
