"use client";

import { useEffect, useRef } from "react";

/**
 * タブへ復帰したときに権限を取り直す最短間隔(ms)。@codex #367 P2。
 *
 * 開きっぱなしの画面で管理者が権限を剥奪しても、各画面の「進入時に最大1回」だけでは
 * 遷移・リロードまで反映されない。その追従経路だが、タブ切替のたびに
 * /api/me/permissions を叩くのは無駄なので間引く。
 * 60秒 =「席を外して戻る」粒度では必ず取り直し、切替の連打では叩かない値。
 */
export const PERMISSIONS_REVALIDATE_INTERVAL_MS = 60_000;

/**
 * タブが可視になったとき(復帰時)に onRevalidate を呼ぶ。
 *
 * ⚠**画面保護(S1b-2)の enforcement ではない**。このフックの関心は「配布中の権限が
 * 古くなっていないか」だけで、透かし・オーバーレイ・コピー抑止・監査には一切触れない
 * (S1b-2 で「provider に visibilitychange / blur の監視挙動を持ち込まない」と決めた
 * スコープ線引きを守るため、権限鮮度の関心をこのモジュールへ分離している)。
 *
 * 呼ぶ条件:
 *   - タブが可視のときだけ(非表示タブでは叩かない)
 *   - 直近の取得から PERMISSIONS_REVALIDATE_INTERVAL_MS 未満なら**間隔の残り時間だけ
 *     遅らせて1回だけ実行する**(@codex #367 P2)。単に捨てると、60秒以内に戻ってきて
 *     そのままタブに留まった場合、離席中の剥奪が**次の切替まで反映されない**まま残る。
 *   - 予約は同時に1本だけ(多重予約しない)。listener と予約は unmount で必ず解除する。
 *
 * @param onRevalidate 取り直し処理。**背景取得**(ローディング状態を立てない)を想定。
 *   前景取得にすると復帰のたびにボタンが一瞬消える。
 * @param lastLoadedAtRef 直近に取得を試みた時刻(ms)。取得側の finally で更新する。
 */
export function usePermissionsRevalidation(
  onRevalidate: () => void,
  lastLoadedAtRef: { current: number },
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const runIfVisible = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      onRevalidate();
    };

    const handler = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      const elapsed = Date.now() - lastLoadedAtRef.current;
      if (elapsed >= PERMISSIONS_REVALIDATE_INTERVAL_MS) {
        onRevalidate();
        return;
      }
      // 間引き中: 捨てずに残り時間ぶん遅らせて1回だけ実行する。
      if (timerRef.current !== null) return; // 予約済みなら増やさない
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        runIfVisible();
      }, PERMISSIONS_REVALIDATE_INTERVAL_MS - elapsed);
    };

    document.addEventListener("visibilitychange", handler);
    window.addEventListener("focus", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("focus", handler);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [onRevalidate, lastLoadedAtRef]);
}
