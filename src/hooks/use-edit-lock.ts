"use client";

/**
 * 鍵を持つ側の hook(仕様 6.2)。**判断・タイマーはすべて
 * `createEditLockController`(`@/lib/edit-lock/controller`)に集約**し、
 * ここは React への結線(state・イベントリスナーの mount/unmount)だけを持つ
 * (`use-address-lookup.ts` と `createAddressLookupController` の関係と同じ作り)。
 *
 * ⚠このファイルにロジックを足さない。ロジックが要るなら controller.ts へ足す
 *   (node で実挙動テストできるのはそちら側だけ=このファイルは jsdom/renderHook を
 *   使わない方針のため source assertion でしか固定できない)。
 *
 * ⚠(review round1 I5) controller は `useEffect` の中ではなく `useMemo` で
 *   render 中に作る。effect の中で作ると、子コンポーネントの effect は親より先に
 *   走るため、子が mount 直後に `acquire()` を呼ぶと「まだ controller が無い」
 *   状態で `controllerRef.current?.acquire()` が黙って何もせず成功したように
 *   見えてしまう(呼び出し側は鍵を取れたと思い込む)。`useMemo` なら render の
 *   時点で必ず存在する(`enabled:false` のときは意図して `null` のまま=これは
 *   事故ではなく仕様)。
 * ⚠(review round1 I3) unmount・resourceId 変化・enabled=false への遷移のいずれでも、
 *   `dispose()` の**前**に `onHidden()`(beacon)を呼び、サーバ側の鍵を手放す。
 *   `dispose()` だけでは合図が止まるだけで鍵はサーバに残り、次の人が
 *   `EDIT_LOCK_HEARTBEAT_GRACE_MS`(5分)ブロックされる。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acquireEditLockApi,
  heartbeatEditLockApi,
  releaseEditLockApi,
  releaseEditLockByBeacon,
} from "@/lib/api-client";
import { createEditLockController, type EditLockController } from "@/lib/edit-lock/controller";
import type { EditLockUiState } from "@/lib/edit-lock/ui-state";

export interface UseEditLockOptions {
  resourceType: "property" | "owner";
  resourceId: string;
  /** false の間は意図して何もしない(カードが閉じている・画面がまだ編集モードでない等)。 */
  enabled?: boolean;
}

/**
 * component 外(モジュールスコープ)に置く。`Date.now()` を render 中の関数の
 * 中に直接書くと、react-hooks の purity チェックが「render 中に不純関数を
 * 呼んでいる」と誤検知する(実際には controller 内部から後で呼ばれるだけで、
 * render 自体は呼ばない)。この間接を挟むだけで解消する。
 */
function now(): number {
  return Date.now();
}

export function useEditLock({ resourceType, resourceId, enabled = true }: UseEditLockOptions) {
  const [state, setState] = useState<EditLockUiState>({ kind: "idle" });
  const [warnIdle, setWarnIdle] = useState(false);

  // render 中に作る(effect 待ちにしない=I5)。enabled=false の間は意図して null。
  // setState/setWarnIdle は useState の更新関数(参照が安定)なので deps に含めない。
  const controller: EditLockController | null = useMemo(() => {
    if (!enabled) return null;
    return createEditLockController({
      acquire: () => acquireEditLockApi(resourceType, resourceId),
      heartbeat: (active) => heartbeatEditLockApi(resourceType, resourceId, active),
      release: (lockId) => releaseEditLockApi(resourceType, resourceId, lockId),
      releaseByBeacon: (lockId) => releaseEditLockByBeacon(resourceType, resourceId, lockId),
      onState: (next, warn) => {
        setState(next);
        setWarnIdle(warn);
      },
      now,
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    });
  }, [enabled, resourceType, resourceId]);

  // ⚠**この hook は他タブからの問い合わせに答える応答器を張らない**
  //   (外部レビュー@codex P1・2026-09-26。横断レビュー M1 の「鍵を使っている間だけ
  //   張る」という裁定を取り消したもの)。理由2つ:
  //   ① この hook はカードごと・編集ごとに立つので、ここで張ると文書あたりの本数が
  //      所有者の数だけ増える(M1 の本当の不満はこの**本数**だった)。
  //   ② 「編集している間だけ」に絞ると、**編集を始める前のタブには応答器が無い**。
  //      空いている物件詳細のタブを複製すると元のタブが誰も答えないため、複製タブは
  //      写し取った合言葉を使い続け、あとで両方が所有者を編集し始めても
  //      `held_by_self_other_screen` にならず同じ画面として扱われる
  //      (D6「自分の別の窓も待つ」が黙って成り立たなくなる)。
  //   応答器は**画面(親)で1本だけ・画面の寿命ぶん**張る
  //   (`src/app/(dashboard)/properties/[id]/page.tsx` の複製タブ確認の隣)。
  //   設置箇所は `screen-token-client.test.ts` の走査で1箇所に固定している。

  // controller が変わる(=disable/別レコードへ切替/unmount)たびに、鍵を手放してから破棄する。
  // ⚠(review round1 I3) onHidden() を dispose() より先に呼ぶ(beacon はヘッダ不要=
  //   unmount 中でも安全に送れる。dispose だけでは鍵がサーバに5分残る)。
  useEffect(() => {
    if (!controller) return;
    // ⚠(横断レビュー C1) **cleanup の dispose() を先頭で取り消す**。React StrictMode は
    //   effect を mount→cleanup→mount と二重に呼ぶが、controller を持つ上の useMemo は
    //   effect の再実行では作り直されないため、2回目の mount は dispose 済みの同じ
    //   インスタンスを掴む。revive() が無いと、以後の acquire() はサーバが許可した鍵を
    //   捨てて beacon で返し、state は idle のまま=帯も通知も出ないのに保存ボタンだけが
    //   永久に押せない(開発環境で編集ウィンドウを開くたびに起きる)。
    //   revive() は窓口も合図も触らないので、毎回無条件に呼んで安全。
    controller.revive();
    return () => {
      controller.onHidden();
      controller.dispose();
      setState({ kind: "idle" });
      setWarnIdle(false);
    };
  }, [controller]);

  // 裏から戻ったら即1回合図(iPhoneでは裏に回ると合図が止まる=正常。復帰時に取り戻す)。
  useEffect(() => {
    if (!controller) return;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") controller.onVisible();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [controller]);

  // 画面を閉じるとき(pagehide)は beacon で解除する(ヘッダが付けられないため本文に合言葉を積む)。
  useEffect(() => {
    if (!controller) return;
    const onHide = () => controller.onHidden();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [controller]);

  const acquire = useCallback(async () => {
    await controller?.acquire();
  }, [controller]);

  const release = useCallback(async () => {
    await controller?.release();
  }, [controller]);

  /** 入力・キー・ポインタのときに呼ぶ。期限切れならここで取り直す(管理者解除/削除はしない)。 */
  const noteActivity = useCallback(() => {
    controller?.noteActivity();
  }, [controller]);

  /** 保存が断られたときに呼ぶ。鍵と無関係なコードなら状態は変えない。 */
  const noteSaveError = useCallback(
    (code: string | null, holderName: string | null = null) => {
      controller?.noteSaveError(code, holderName);
    },
    [controller],
  );

  /**
   * 423 の後で状態窓口が保持者を名乗れたら、帯の氏名・開始時刻を実名へ差し替える
   * (仕上げround2)。「`taken` の間だけ効かせる」判断は controller 側が持つ。
   */
  const noteSaveErrorHolder = useCallback(
    (holderName: string, since?: string) => {
      controller?.noteSaveErrorHolder(holderName, since);
    },
    [controller],
  );

  return {
    state,
    acquire,
    release,
    noteActivity,
    noteSaveError,
    noteSaveErrorHolder,
    /** 保存ボタンを押せるか。 */
    canSave: state.kind === "mine",
    /** 55分の予告を出すか(DBの時計基準)。 */
    warnIdle,
    lockId: state.kind === "mine" ? state.lockId : null,
  };
}

export type UseEditLockReturn = ReturnType<typeof useEditLock>;
