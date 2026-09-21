"use client";

/**
 * 鍵を持つ側の hook(仕様 6.2)。**判断・タイマーはすべて
 * `createEditLockController`(`@/lib/edit-lock/controller`)に集約**し、
 * ここは React への結線(state・ref・イベントリスナーの mount/unmount)だけを持つ
 * (`use-address-lookup.ts` と `createAddressLookupController` の関係と同じ作り)。
 *
 * ⚠このファイルにロジックを足さない。ロジックが要るなら controller.ts へ足す
 *   (node で実挙動テストできるのはそちら側だけ=このファイルは jsdom/renderHook を
 *   使わない方針のため source assertion でしか固定できない)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireEditLockApi,
  heartbeatEditLockApi,
  releaseEditLockApi,
  releaseEditLockByBeacon,
} from "@/lib/api-client";
import { answerScreenTokenProbes } from "@/lib/edit-lock/screen-token-client";
import { createEditLockController, type EditLockController } from "@/lib/edit-lock/controller";
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";

export interface UseEditLockOptions {
  resourceType: "property" | "owner";
  resourceId: string;
  /** false の間は何もしない(カードが閉じている・画面がまだ編集モードでない等)。 */
  enabled?: boolean;
}

export function useEditLock({ resourceType, resourceId, enabled = true }: UseEditLockOptions) {
  const [state, setState] = useState<EditLockUiState>({ kind: "idle" });
  const [warnIdle, setWarnIdle] = useState(false);
  const controllerRef = useRef<EditLockController | null>(null);

  // 他のタブからの「その合言葉を使っていますか」に答え続ける(タブ複製の検知に要る)。
  useEffect(() => answerScreenTokenProbes(), []);

  // controller の生成/破棄。resourceType/resourceId が変わったら(別レコードを開いた等)
  // 古い controller を確実に dispose してから新しい controller を作る。
  useEffect(() => {
    if (!enabled) return;
    const controller = createEditLockController({
      acquire: () => acquireEditLockApi(resourceType, resourceId),
      heartbeat: (active) => heartbeatEditLockApi(resourceType, resourceId, active),
      release: (lockId) => releaseEditLockApi(resourceType, resourceId, lockId),
      releaseByBeacon: (lockId) => releaseEditLockByBeacon(resourceType, resourceId, lockId),
      onState: (next, warn) => {
        setState(next);
        setWarnIdle(warn);
      },
      now: () => Date.now(),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
      setState({ kind: "idle" });
      setWarnIdle(false);
    };
  }, [enabled, resourceType, resourceId]);

  // 裏から戻ったら即1回合図(iPhoneでは裏に回ると合図が止まる=正常。復帰時に取り戻す)。
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") controllerRef.current?.onVisible();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled]);

  // 画面を閉じるとき(pagehide)は beacon で解除する(ヘッダが付けられないため本文に合言葉を積む)。
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => controllerRef.current?.onHidden();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [enabled]);

  const acquire = useCallback(async () => {
    await controllerRef.current?.acquire();
  }, []);

  const release = useCallback(async () => {
    await controllerRef.current?.release();
  }, []);

  /** 入力・キー・ポインタのときに呼ぶ。期限切れならここで取り直す(管理者解除/削除はしない)。 */
  const noteActivity = useCallback(() => {
    controllerRef.current?.noteActivity();
  }, []);

  /** 保存が断られたときに呼ぶ。鍵と無関係なコードなら状態は変えない。 */
  const noteSaveError = useCallback((code: string | null, holderName: string | null = null) => {
    controllerRef.current?.noteSaveError(code, holderName);
  }, []);

  return {
    state,
    acquire,
    release,
    noteActivity,
    noteSaveError,
    /** 保存ボタンを押せるか。 */
    canSave: state.kind === "mine",
    /** 55分の予告を出すか(DBの時計基準)。 */
    warnIdle,
    lockId: state.kind === "mine" ? state.lockId : null,
  };
}

export type UseEditLockReturn = ReturnType<typeof useEditLock>;
