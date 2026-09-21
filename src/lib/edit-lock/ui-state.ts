/**
 * 窓口の応答 → 画面(帯・保存ボタン)の状態への写像。**純関数だけ**。
 *
 * React の中に散らすと組み合わせを試せないので、判断はすべてここに集める
 * (hook は結線のみ)。仕様 6.2 の分岐がそのまま1つの型になっている。
 */
import { EDIT_LOCK_IDLE_WARN_MS } from "./rules";

/** 取得の応答(200=裸の mine / 423=裸の held)。 */
export type AcquireResponse =
  | { state: "mine"; lockId: string; since: string }
  | {
      code: "EDIT_LOCKED";
      state: "held_by_other" | "held_by_self_other_screen";
      holderName: string;
      since: string;
    };

/** 合図の応答。`notFound` は 404(資源が消えた)を呼び出し側が畳んだ形。 */
export type HeartbeatResponse =
  | { state: "mine"; idleSince: string }
  | { state: "lost"; reason: "expired" | "force_released" }
  | { state: "taken"; holderName: string; since: string }
  | { notFound: true };

export type EditLockUiState =
  /** まだ取得していない(閲覧中)。 */
  | { kind: "idle" }
  /** 自分が鍵を持っている。保存できる。 */
  | { kind: "mine"; lockId: string; since?: string; idleSince?: string }
  /** 期限切れ・世代違い。入力したら自動で取り直す。入力は消さない。 */
  | { kind: "expired" }
  /** 管理者が外した。保存できない。**自動の取り直しはしない**。 */
  | { kind: "force_released" }
  /** 他の人(または自分の別画面)が持っている。保存できない。 */
  | { kind: "taken"; holderName: string; since?: string }
  /** 資源そのものが消えた。保存できない・再試行もしない。 */
  | { kind: "deleted" };

export function uiStateFromAcquire(res: AcquireResponse): EditLockUiState {
  if (res.state === "mine") return { kind: "mine", lockId: res.lockId, since: res.since };
  // held_by_other / held_by_self_other_screen はどちらも「他の画面が持っている」=待つ(D6)。
  return { kind: "taken", holderName: res.holderName, since: res.since };
}

export function uiStateFromHeartbeat(res: HeartbeatResponse, lockId: string): EditLockUiState {
  if ("notFound" in res) return { kind: "deleted" };
  if (res.state === "mine") return { kind: "mine", lockId, idleSince: res.idleSince };
  if (res.state === "taken") return { kind: "taken", holderName: res.holderName, since: res.since };
  return res.reason === "force_released" ? { kind: "force_released" } : { kind: "expired" };
}

/**
 * 保存が断られたときの写像。**封筒のコード**で分かれる(仕様 4.7)。
 * 鍵と無関係なコードでは `null` を返し、呼び出し側は今の状態を保つ。
 */
export function uiStateFromSaveError(code: string | null, holderName: string | null): EditLockUiState | null {
  switch (code) {
    case "EDIT_LOCK_STALE":
      // 世代が合わない=鍵は既に外れている。意味は期限切れと同じ(仕様 6.2)。
      return { kind: "expired" };
    case "EDIT_LOCK_FORCE_RELEASED":
      return { kind: "force_released" };
    case "EDIT_LOCKED":
      return { kind: "taken", holderName: holderName ?? "他の利用者" };
    default:
      return null;
  }
}

/** 入力したときに自動で取り直してよいか。⚠管理者が外した場合と資源が消えた場合はしない。 */
export function shouldReacquireOnInput(state: EditLockUiState): boolean {
  return state.kind === "expired";
}

/** 55分の予告を出すか。**DBの時計が起点**(`idleSince`)。 */
export function shouldWarnIdle(state: EditLockUiState, nowMs: number): boolean {
  if (state.kind !== "mine" || !state.idleSince) return false;
  return nowMs - new Date(state.idleSince).getTime() >= EDIT_LOCK_IDLE_WARN_MS;
}
