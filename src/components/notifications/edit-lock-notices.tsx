"use client";

/**
 * 編集ロックの N1・N2(設計書 §4.2・§4.6)。**帯(`EditLockBanner`)の隣に置くだけで何も描かない**。
 *
 * - 画面を見ているとき: 今の帯だけ(二重に出さない)。
 * - 別の画面を見ているとき: ベルに残し、許可があれば OS の通知も出す。
 *   外れた(N2)場合は、画面に戻ったときに右下のポップアップで理由を出す。
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
  type EditLockSnapshot,
} from "@/lib/notifications/edit-lock-notice";
import { useNotices } from "./notice-provider";

export function EditLockNotices({
  state,
  warnIdle,
  resourceType,
  resourceId,
}: {
  state: EditLockUiState;
  warnIdle: boolean;
  resourceType: "property" | "owner";
  /** UUID のみ(通知の重複防止の印に使う)。 */
  resourceId: string;
}) {
  const { notify, toast } = useNotices();
  const prevRef = useRef<EditLockSnapshot>({ kind: "idle", warnIdle: false });
  const pendingReturnRef = useRef<string | null>(null);

  useEffect(() => {
    const next: EditLockSnapshot = { kind: state.kind, warnIdle };
    const event = editLockNoticeEvent(prevRef.current, next);
    prevRef.current = next;
    if (!event || document.visibilityState !== "hidden") return;
    const context = editLockContextLabel(resourceType);
    const url = window.location.pathname;
    if (event.type === "warn") {
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
    const body = editLockLostBody(event.reason);
    notify({
      kind: "edit_lock_lost",
      tag: `edit-lock:lost:${resourceType}:${resourceId}`,
      title: EDIT_LOCK_LOST_TITLE,
      body,
      context,
      url,
      osWhenHidden: true,
    });
    pendingReturnRef.current = body;
  }, [state.kind, warnIdle, resourceType, resourceId, notify]);

  // 画面に戻ったとき、見ていない間に外れていた理由をはっきり出す(§4.6 の 1)。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      const body = pendingReturnRef.current;
      if (!body) return;
      pendingReturnRef.current = null;
      toast({ tone: "red", icon: "unlock", title: EDIT_LOCK_LOST_TITLE, body });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [toast]);

  return null;
}
