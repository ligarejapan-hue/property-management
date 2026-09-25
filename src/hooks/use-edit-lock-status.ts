"use client";

/**
 * 見ている側の hook(仕様 6.3)。**周期・分割・staleの破棄はすべて
 * `createEditLockStatusController`(`@/lib/edit-lock/status-controller`)に集約**し、
 * ここは React への結線(state・visibilitychange・resources の変化への追従)だけを
 * 持つ(`use-edit-lock.ts`/`createEditLockController` の関係と同じ作り)。
 *
 * ⚠このファイルにロジックを足さない。ロジックが要るなら status-controller.ts へ
 *   足す(node で実挙動テストできるのはそちら側だけ=このファイルは jsdom/renderHook
 *   を使わない方針のため source assertion でしか固定できない)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchEditLockStatus, type EditLockStatusRow } from "@/lib/api-client";
import {
  createEditLockStatusController,
  findEditLockStatusRow,
  type EditLockStatusController,
  type EditLockStatusResource,
} from "@/lib/edit-lock/status-controller";

export interface UseEditLockStatusOptions {
  /** false の間は意図して何も問い合わせない(物件がまだ読み込めていない等)。 */
  enabled?: boolean;
}

export interface UseEditLockStatusReturn {
  rows: EditLockStatusRow[];
  /** 即座に1回問い合わせる(管理者が鍵を外した直後に使う・仕様 6.3)。 */
  refresh: () => void;
  byKey: (resourceType: EditLockStatusResource["resourceType"], resourceId: string) => EditLockStatusRow | undefined;
}

function isHidden(): boolean {
  return document.visibilityState === "hidden";
}

export function useEditLockStatus(
  resources: EditLockStatusResource[],
  { enabled = true }: UseEditLockStatusOptions = {},
): UseEditLockStatusReturn {
  const [rows, setRows] = useState<EditLockStatusRow[]>([]);

  // render 中に作る(use-edit-lock.tsのuseMemoと同じ理由=子の先行effectでも
  // controllerが無いままにならない)。enabled=false の間は意図してnull。
  const controller: EditLockStatusController | null = useMemo(() => {
    if (!enabled) return null;
    return createEditLockStatusController({
      fetchStatus: fetchEditLockStatus,
      onRows: setRows,
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      isHidden,
    });
  }, [enabled]);

  // このcontrollerインスタンスに対して既に start() 済みか(下のeffectが
  // start/setResourcesのどちらを呼ぶべきかを決める・review自己点検で追加)。
  // ⚠2本のeffectを素朴に分けると([controller]で1本・[resources]で別の1本)、
  //   mount時に両方が同じ commit 内で走り、start() の直後に setResources() が
  //   即座に走って(まだ何も解決していない)最初の poll の seq を自ら古くして
  //   しまう(開いたときの1回が必ず握りつぶされる)。1本のeffectにまとめ、
  //   「このcontrollerに対して初めてか」で start/setResources を出し分ける
  //   (`use-address-lookup.ts` の controllerRef と同じ、mount時1回だけ作る形)。
  const startedControllerRef = useRef<EditLockStatusController | null>(null);

  // controller が変わる(=enabled のON/OFF・unmount)たびに後始末する。
  // ⚠(react-hooks/set-state-in-effect) enabled=falseのときのrowsは、effectで
  //   setRows([])を呼ばず、下の返り値で`controller ? rows : []`として導出する
  //   (render中に決まる値をeffectでsetStateし直す=カスケード再描画になるため)。
  useEffect(() => {
    if (!controller) return;
    return () => {
      controller.stop();
      if (startedControllerRef.current === controller) startedControllerRef.current = null;
    };
  }, [controller]);

  // 資源の一覧(物件+所有者)が変わったら差し替える(所有者の追加・削除等)。
  // このcontrollerに対して初めてなら start()(開いたとき1回+周期を始める)、
  // 2回目以降は setResources()(一覧の差し替えだけ)。
  useEffect(() => {
    if (!controller) return;
    if (startedControllerRef.current !== controller) {
      startedControllerRef.current = controller;
      controller.start(resources);
    } else {
      controller.setResources(resources);
    }
  }, [controller, resources]);

  // ⚠react-hooks/refs: render中にrefへ書き込めない(use-edit-lock.tsと同様、
  //   controllerRef を持たず render スコープの `controller` をそのまま閉じ込める。
  //   `controller` はuseMemoの結果なので参照は安定している=[controller]依存で足りる)。
  const refresh = useCallback(() => {
    controller?.refresh();
  }, [controller]);

  // enabled=false(controller=null)の間は問い合わせていない=常に空(stale rowsを見せない)。
  const effectiveRows = useMemo(() => (controller ? rows : []), [controller, rows]);

  const byKey = useCallback(
    (resourceType: EditLockStatusResource["resourceType"], resourceId: string) =>
      findEditLockStatusRow(effectiveRows, resourceType, resourceId),
    [effectiveRows],
  );

  return {
    rows: effectiveRows,
    refresh,
    byKey,
  };
}

export type UseEditLockStatusHookReturn = ReturnType<typeof useEditLockStatus>;
