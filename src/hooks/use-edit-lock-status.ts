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
  // start/setResourcesのどちらを呼ぶべきかを決める)。
  // ⚠(review round2 N3で説明を書き直し) `start()`(review round1 Critical/Minor10で
  //   冪等にした)と `setResources()` は**同じ仕事をしない**——start()は間隔を
  //   張り直し(30秒周期の位相をリセット)て即座に1回問い合わせるのに対し、
  //   setResources()は周期の位相を保ったまま一覧だけ差し替え、中身が実際に
  //   変わったときだけその場で1回問い合わせる(review round1 Important 4)。
  //   もしこのrefを外して資源の一覧が変わるたびに(冪等だからという理由で)
  //   start()を呼んでしまうと、`fetchProperty` などで一覧が値としては同じ
  //   配列に差し替わるたびに周期がリセットされ、かつ無駄な即時問い合わせが
  //   1回増える(Important 4が塞いだはずの「参照だけ新しい配列」問題が
  //   別の入口から戻ってくる)。「開いたときに1回だけ start()・以後は
  //   setResources()」という区別を保つために、このcontrollerインスタンスに
  //   対して初めてかどうかをこのrefで覚えておく。
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

  // 裏から戻ったら即1回問い合わせる(review round1 Minor 15)。鍵を持つ側
  // (use-edit-lock.ts の onVisible)と同じ体感にする——直さないと、隠れている
  // 間にhold状態が変わっても、表に戻ってから最大30秒(次のtick)まで気づけない。
  // ⚠(review round1 Critical) start()がstoppedを戻し冪等になったことで、
  //   このリスナーが呼ぶ refresh() が固まる/漏れる心配が無くなった。
  useEffect(() => {
    if (!controller) return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") controller.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [controller]);

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
