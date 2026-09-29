/**
 * 編集ロックの状態の変わり目 → 知らせるかどうか(N1・N2・設計書 §4.2・§4.6)。**純関数だけ**。
 *
 * - 鍵の規則(55分の予告・60分・5分の合図切れ)は変えない。`useEditLock` が返す
 *   `state`/`warnIdle` の変わり目を見るだけ。
 * - 画面を見ているとき(タブが見えている)は今の帯だけ。二重に出さない(呼び出し側で判定)。
 * - ⚠文言は種類と理由だけ。保持者の氏名・物件名などは入れない(OS の通知にも出るため)。
 */
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";

export type EditLockLostReason = "expired" | "force_released" | "taken" | "deleted";

export type EditLockNoticeEvent =
  | { type: "warn" }
  | { type: "lost"; reason: EditLockLostReason }
  | null;

export interface EditLockSnapshot {
  kind: EditLockUiState["kind"];
  warnIdle: boolean;
}

export function editLockNoticeEvent(prev: EditLockSnapshot, next: EditLockSnapshot): EditLockNoticeEvent {
  if (next.kind === "mine" && next.warnIdle && !(prev.kind === "mine" && prev.warnIdle)) {
    return { type: "warn" };
  }
  if (
    prev.kind === "mine" &&
    (next.kind === "expired" || next.kind === "force_released" || next.kind === "taken" || next.kind === "deleted")
  ) {
    return { type: "lost", reason: next.kind };
  }
  return null;
}

export const EDIT_LOCK_WARN_TITLE = "編集権限がまもなく外れます";
export const EDIT_LOCK_WARN_BODY = "編集中の画面が5分後に閉じられます。続ける場合は画面に戻ってください";
export const EDIT_LOCK_LOST_TITLE = "編集権限が外れました";

export function editLockLostBody(reason: EditLockLostReason): string {
  switch (reason) {
    case "expired":
      return "しばらく操作がなかった、または画面が止まっていたため、編集権限が外れました";
    case "force_released":
      return "管理者が編集を終了したため、編集権限が外れました";
    case "taken":
      return "別の画面で編集が始まったため、編集権限が外れました";
    case "deleted":
      return "記録が削除されたため、編集を続けられません";
  }
}

export function editLockContextLabel(resourceType: "property" | "owner"): string {
  return resourceType === "property" ? "物件の編集" : "所有者の編集";
}
