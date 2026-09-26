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
  /**
   * 他の人(または自分の別画面)が持っている。保存できない。
   * ⚠`bySelfOtherScreen` = **自分自身の別画面**が持っている(取得の423が
   *   `held_by_self_other_screen` だった)。待つ側になるのは同じ(D6)だが、
   *   帯に自分の氏名を「◯◯さんが編集を始めました」と出してはいけないため、
   *   状態として区別して運ぶ(横断レビュー I2)。合図の `taken` は窓口が
   *   この区別を返さないので印は付かない(=他の人として扱う)。
   */
  | { kind: "taken"; holderName: string; since?: string; bySelfOtherScreen?: boolean }
  /** 資源そのものが消えた。保存できない・再試行もしない。 */
  | { kind: "deleted" };

export function uiStateFromAcquire(res: AcquireResponse): EditLockUiState {
  if (res.state === "mine") return { kind: "mine", lockId: res.lockId, since: res.since };
  // held_by_other / held_by_self_other_screen はどちらも「他の画面が持っている」=待つ(D6)。
  // ⚠ただし**どちらかは区別して運ぶ**(横断レビュー I2)。畳んでしまうと帯が
  //   自分自身の氏名を他人として出す(ページを開いた直後の競合の窓で現実に踏める)。
  return {
    kind: "taken",
    holderName: res.holderName,
    since: res.since,
    bySelfOtherScreen: res.state === "held_by_self_other_screen",
  };
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
export function uiStateFromSaveError(
  code: string | null,
  holderName: string | null,
  since?: string,
): EditLockUiState | null {
  switch (code) {
    case "EDIT_LOCK_STALE":
      // 世代が合わない=鍵は既に外れている。意味は期限切れと同じ(仕様 6.2)。
      return { kind: "expired" };
    case "EDIT_LOCK_FORCE_RELEASED":
      return { kind: "force_released" };
    case "EDIT_LOCKED":
      // ⚠(仕上げround2) 窓口の423は氏名も開始時刻も返さないので、まずは既定の呼び名で
      //   帯を出す(帯を空にしない)。状態窓口の問い合わせが保持者を名乗れたら、
      //   呼び出し側が実名+開始時刻でこの写像をもう一度通す
      //   (`controller.noteSaveErrorHolder`)。`since` は取得・合図の taken と同じ
      //   位置に入れる=この経路だけ状態の形を欠けさせない。
      return { kind: "taken", holderName: holderName ?? "他の利用者", since };
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

/**
 * 開始時刻は現地時間の HH:mm(仕様の見本と同じ)。解釈できない値は空文字(review Minor #1)。
 *
 * ⚠**このファイル(純関数だけ・`"use client"` を持たない)に置く**(review round2
 *   Important B)。元は `edit-lock-banner.tsx`("use client"・`ui/button`・
 *   `ui/confirm-dialog`・`api-client` を引き込む)にあり、`src/lib/edit-lock/
 *   locked-message.ts`(鍵を持たない入口が使う純粋な組み立て関数)がそこから
 *   importすると、地番ポップアップのようにこれまで帯に依存していなかった
 *   画面までその一式を巻き込んでしまう。Task 6 fix round 1 #3 が
 *   `canSubmitSave`/`shouldShowLockUnavailableNotice` を同じ理由で
 *   component モジュールの外へ出した判断と揃える。`edit-lock-banner.tsx` は
 *   ここから re-export し、既存の呼び出し元(テスト含む)はそのまま動く。
 */
export function formatSince(since?: string): string {
  if (!since) return "";
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
