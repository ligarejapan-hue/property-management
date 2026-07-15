"use client";

import { useEffect, useRef } from "react";
import { signOut } from "next-auth/react";
import {
  readSharedLastActivity,
  writeSharedLastActivity,
} from "@/lib/session-activity";

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
const STORAGE_WRITE_THROTTLE_MS = 10 * 1000; // localStorage への書込は最大10秒に1回
// タブ間で最終操作時刻を共有する仕組みは @/lib/session-activity に集約(@codex #290 R2/R7)。

export function IdleSessionGuard() {
  // render 中に Date.now() を呼ばない(react-hooks/purity)。0 で初期化し effect 内で現在時刻を入れる。
  const lastActivityRef = useRef<number>(0);
  const lastRefreshRef = useRef<number>(0);
  const lastStorageWriteRef = useRef<number>(0);

  useEffect(() => {
    // モック(NEXT_PUBLIC_USE_MOCK=true)は auth 自体をバイパスする(proxy.ts も同様)。
    // このガードだけが 1 時間で signOut すると dev/mock セッションを誤って落とすため何もしない
    // (@codex #290 R4 P3)。
    if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return;

    const startNow = Date.now();
    // @codex #290 R7(P2): マウント/リロード時は保存済みの最終操作(全タブ共有)を起点にする。
    // startNow で無条件に上書きすると、60〜65分アイドル(cookie バッファでまだ失効前)後の
    // リロードで無操作の痕跡が消え、ログアウトを免れる。ログイン直後は login ページが直近値を
    // seed するため stored は新しく、ここで誤ログアウトしない。
    const storedLast = readSharedLastActivity();
    const effectiveLast = storedLast > 0 ? storedLast : startNow;
    if (startNow - effectiveLast >= IDLE_TIMEOUT_MS) {
      // 既に無操作上限を超えている(バッファ窓でのリロード等)→ そのままログアウト。
      void signOut({ callbackUrl: "/login" });
      return;
    }
    lastActivityRef.current = effectiveLast;
    lastRefreshRef.current = startNow;

    // 前回更新から REFRESH_INTERVAL 以上経っていればセッションを延長(スライド)。throttle 済。
    const maybeRefreshSession = (now: number) => {
      if (now - lastRefreshRef.current >= REFRESH_INTERVAL_MS) {
        lastRefreshRef.current = now;
        // セッションendpointを直接叩くと updateAge に従い JWT が回転し cookie が延長される。
        // getSession(next-auth/react)は既定で結果をブロードキャストし、一時失敗(null)が
        // SessionProvider 経由で UI をログアウト状態に切り替えかねないため、素の fetch にする
        // (@codex #290 R4)。回転済み cookie は Set-Cookie で反映される。
        void fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
        }).catch(() => {
          /* ネットワーク一時失敗は無視(次の機会に再試行) */
        });
      }
    };

    const markActivity = () => {
      const now = Date.now();
      // @codex #290 R5(P1): スリープ/長時間の背景化で interval が境界(1時間)で発火しなかった
      // 場合、復帰後の最初の操作が古い最終操作時刻を上書きすると無操作の痕跡が消え、ログアウトが
      // 効かなくなる。過去の最終操作を「上書きする前に」超過判定し、超えていれば signOut する。
      // 他タブが起きていた場合は共有値が新しいので誤ログアウトしない(Math.max)。
      const prevLastActivity = Math.max(
        lastActivityRef.current,
        readSharedLastActivity(),
      );
      if (now - prevLastActivity >= IDLE_TIMEOUT_MS) {
        void signOut({ callbackUrl: "/login" });
        return;
      }
      lastActivityRef.current = now;
      // 全タブへ共有(書込は throttle。頻発する mousemove で localStorage を叩き続けない)。
      if (now - lastStorageWriteRef.current >= STORAGE_WRITE_THROTTLE_MS) {
        lastStorageWriteRef.current = now;
        writeSharedLastActivity(now);
      }
      // @codex #290 R3: 復帰(操作再開)の瞬間に即延長する。次の tick(最大1分後・背景タブでは
      // タイマー間引きでさらに遅延)まで待つと、境界で cookie が失効して誤ログアウトし得るため、
      // 操作検知の時点で(前回更新が古ければ)延長を発火する。
      maybeRefreshSession(now);
    };
    // 空(新規)のときだけ seed。既存の直近値は保持する(上の effectiveLast 判定を壊さない)。
    if (storedLast <= 0) writeSharedLastActivity(startNow);

    // scroll は bubbling しない=本文の内側スクロールコンテナ(overflow-y-auto)を拾うため
    // capture フェーズで購読する。wheel も内側スクロール操作として活動に数える
    // (@codex #290 R2)。
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "wheel",
      "touchstart",
    ];
    for (const ev of events) {
      window.addEventListener(ev, markActivity, { passive: true, capture: true });
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      // 自タブと他タブ(localStorage)の最終操作のうち新しい方を採用=どのタブの操作も活動に数える。
      const lastActivity = Math.max(
        lastActivityRef.current,
        readSharedLastActivity(),
      );
      const idleFor = now - lastActivity;

      // 全タブで無操作が上限を超えたらログアウト。
      if (idleFor >= IDLE_TIMEOUT_MS) {
        void signOut({ callbackUrl: "/login" });
        return;
      }

      // backup: 直近に操作があれば延長(通常は markActivity 側で即延長済み)。
      // idle 中(REFRESH_INTERVAL 以上無操作)は延長しない=放置で自然に失効させる。
      if (idleFor < REFRESH_INTERVAL_MS) {
        maybeRefreshSession(now);
      }
    }, CHECK_INTERVAL_MS);

    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, markActivity, { capture: true });
      }
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
