"use client";

import { useEffect, useRef } from "react";
import { getSession, signOut } from "next-auth/react";

/**
 * 無操作アイドルタイムアウト(クライアント側)。
 *
 * 背景(@codex #290 P2): NextAuth の jwt 戦略では `session.updateAge` だけでは
 * ブラウザの cookie は更新されない(セッションendpoint / auth wrapper の応答が
 * Set-Cookie を返す時にのみ JWT が回転する)。このアプリの middleware は cookie の
 * 存在チェックのみ・SessionProvider に定期 refetch も無いため、活動中でも 1 時間の
 * 絶対失効でログアウトしてしまう。そこで「操作を検知して延長」「無操作で失効」を
 * 明示的に行う本コンポーネントを置く。
 *
 * 動作:
 * - ユーザー操作(mousemove/keydown/mousedown/scroll/touchstart)で最終操作時刻を更新。
 * - 60秒ごとに判定:
 *   - 最終操作から IDLE_TIMEOUT_MS(1時間)以上経過 → signOut(=ログアウト)。
 *   - 直近に操作があり、前回更新から REFRESH_INTERVAL_MS 以上経過 → getSession() で
 *     セッションendpointを叩き、JWT を回転させて cookie の有効期限を延長(スライド)。
 * - これにより「操作している間は切れない」「無操作 1 時間でログアウト」を実現する。
 *
 * auth.ts 側は maxAge=1h・updateAge=5min。updateAge < REFRESH_INTERVAL なので
 * 更新のたびに確実に回転する。
 */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 無操作 1 時間でログアウト
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 操作中は最大5分ごとにセッションを延長
const CHECK_INTERVAL_MS = 60 * 1000; // 1分ごとに判定

export function IdleSessionGuard() {
  // render 中に Date.now() を呼ばない(react-hooks/purity)。0 で初期化し effect 内で現在時刻を入れる。
  const lastActivityRef = useRef<number>(0);
  const lastRefreshRef = useRef<number>(0);

  useEffect(() => {
    const startNow = Date.now();
    lastActivityRef.current = startNow;
    lastRefreshRef.current = startNow;

    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
    ];
    for (const ev of events) {
      window.addEventListener(ev, markActivity, { passive: true });
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      const idleFor = now - lastActivityRef.current;

      // 無操作が上限を超えたらログアウト。
      if (idleFor >= IDLE_TIMEOUT_MS) {
        void signOut({ callbackUrl: "/login" });
        return;
      }

      // 直近に操作があり、前回更新から一定時間が経っていればセッションを延長(スライド)。
      // idle 中(REFRESH_INTERVAL 以上無操作)は延長しない=放置で自然に失効させる。
      if (
        idleFor < REFRESH_INTERVAL_MS &&
        now - lastRefreshRef.current >= REFRESH_INTERVAL_MS
      ) {
        lastRefreshRef.current = now;
        // セッションendpointを叩くと updateAge に従い JWT が回転し cookie が延長される。
        void getSession().catch(() => {
          /* ネットワーク一時失敗は無視(次の tick で再試行) */
        });
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, markActivity);
      }
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
