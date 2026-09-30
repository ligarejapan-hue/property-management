"use client";

/**
 * 編集ロックの N1・N2(設計書 §4.2・§4.6)。**帯(`EditLockBanner`)の隣に置くだけで何も描かない**。
 *
 * - 画面を見ているとき: 今の帯だけ(二重に出さない)。
 * - 別の画面を見ているとき: ベルに残し、許可があれば OS の通知も出す。
 *   外れた(N2)場合は、画面に戻ったときに右下のポップアップで理由を出す。
 * - 裏に回した間はタイマーが止まるため、外れたことは**戻った直後の合図**で分かることが多い
 *   (スマホ・背景タブ)。戻ってから `RETURN_WINDOW_MS` 以内に外れたと分かった場合も
 *   「戻ったときの知らせ」として出す(@codex #462)。
 * - 保存前の入力があるときは「保存されていない入力があります」を足す(設計書 §2 N2)。
 * - 鍵の規則・帯の文言は変えない。判断は `lib/notifications/edit-lock-notice.ts`。
 */
import { useEffect, useRef } from "react";
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";
import {
  EDIT_LOCK_LOST_TITLE,
  EDIT_LOCK_WARN_BODY,
  EDIT_LOCK_WARN_TITLE,
  editLockContextLabel,
  editLockLostBody,
  editLockNoticeEvent,
  withUnsavedInputNote,
  type EditLockSnapshot,
} from "@/lib/notifications/edit-lock-notice";
import { useNotices } from "./notice-provider";

/** 画面に戻ってから、戻った直後の合図の結果を「戻ったときの知らせ」として扱う長さ。 */
const RETURN_WINDOW_MS = 15_000;

export function EditLockNotices({
  state,
  warnIdle,
  resourceType,
  resourceId,
  hasUnsavedInput = false,
}: {
  state: EditLockUiState;
  warnIdle: boolean;
  resourceType: "property" | "owner";
  /** UUID のみ(通知の重複防止の印に使う)。 */
  resourceId: string;
  /** 保存前の入力があるか(外れた知らせに「保存されていない入力があります」を足す)。 */
  hasUnsavedInput?: boolean;
}) {
  const { notify, toast } = useNotices();
  const prevRef = useRef<EditLockSnapshot>({ kind: "idle", warnIdle: false });
  const pendingReturnRef = useRef<string | null>(null);
  const returnedAtRef = useRef(0);
  /** 今回の予告(55分)を別の画面向け(ベル・OS の通知)に知らせ済みか。 */
  const warnNotifiedRef = useRef(false);
  const unsavedRef = useRef(hasUnsavedInput);
  useEffect(() => {
    unsavedRef.current = hasUnsavedInput;
  }, [hasUnsavedInput]);

  useEffect(() => {
    const next: EditLockSnapshot = { kind: state.kind, warnIdle };
    const event = editLockNoticeEvent(prevRef.current, next);
    prevRef.current = next;
    if (!(next.kind === "mine" && next.warnIdle)) warnNotifiedRef.current = false;
    if (!event) return;
    const hidden = document.visibilityState === "hidden";
    const justReturned = !hidden && Date.now() - returnedAtRef.current < RETURN_WINDOW_MS;
    // 画面を見ているとき(戻った直後を除く)は今の帯だけ。予告は見ているなら帯で足りる。
    if (!hidden && (event.type === "warn" || !justReturned)) return;
    const context = editLockContextLabel(resourceType);
    const url = window.location.pathname;
    if (event.type === "warn") {
      warnNotifiedRef.current = true;
      notify({
        kind: "edit_lock_warn",
        tag: `edit-lock:warn:${resourceType}:${resourceId}`,
        title: EDIT_LOCK_WARN_TITLE,
        body: EDIT_LOCK_WARN_BODY,
        context,
        url,
        osWhenHidden: true,
      });
      return;
    }
    const body = withUnsavedInputNote(editLockLostBody(event.reason), unsavedRef.current);
    notify({
      kind: "edit_lock_lost",
      tag: `edit-lock:lost:${resourceType}:${resourceId}`,
      title: EDIT_LOCK_LOST_TITLE,
      body,
      context,
      url,
      osWhenHidden: true,
    });
    if (justReturned) {
      toast({ tone: "red", icon: "unlock", title: EDIT_LOCK_LOST_TITLE, body });
      return;
    }
    pendingReturnRef.current = body;
  }, [state.kind, warnIdle, resourceType, resourceId, notify, toast]);

  // 画面に戻ったとき、見ていない間に外れていた理由をはっきり出す(§4.6 の 1)。
  // 予告(帯)が出ている間に別の画面へ移ったときは、そのとき予告をベル・OS の通知に出す(@codex #462)。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        const snap = prevRef.current;
        if (snap.kind === "mine" && snap.warnIdle && !warnNotifiedRef.current) {
          warnNotifiedRef.current = true;
          notify({
            kind: "edit_lock_warn",
            tag: `edit-lock:warn:${resourceType}:${resourceId}`,
            title: EDIT_LOCK_WARN_TITLE,
            body: EDIT_LOCK_WARN_BODY,
            context: editLockContextLabel(resourceType),
            url: window.location.pathname,
            osWhenHidden: true,
          });
        }
        return;
      }
      returnedAtRef.current = Date.now();
      const body = pendingReturnRef.current;
      if (!body) return;
      pendingReturnRef.current = null;
      toast({ tone: "red", icon: "unlock", title: EDIT_LOCK_LOST_TITLE, body });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [toast, notify, resourceType, resourceId]);

  return null;
}
