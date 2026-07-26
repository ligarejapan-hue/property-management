"use client";

/**
 * 謄本所在検索の実況パネル (自動操作のスクショ紙芝居)。
 *
 * - 検索 POST の実行中、親 (registry-location-search-button) が発行した liveRef
 *   の進行状況を 1 秒間隔でポーリングし、ステップ文言 + 最新スクショを表示する。
 * - スクショは「画面全体をそのまま」(viewport) を縮小表示し、クリックで拡大
 *   (ユーザー要望)。ログイン場面はサーバー側で撮影が省略され文言のみ届く。
 * - 完了 (done) でポーリングを停止する。unmount で interval を必ず解除
 *   (use-field-survey-location-recorder の flush timer と同じ規約)。
 * - 実況はメモリ内 TTL の一時データ (実行者本人のみ閲覧可)。404 (未開始/期限
 *   切れ) は「接続中…」のまま静かに待つ (検索本体の成否は親が別途表示する)。
 * - 座標や秘匿情報を console に出さない。
 */

import { useEffect, useRef, useState } from "react";
import {
  fetchRegistryLiveView,
  registryLiveShotUrl,
  type RegistryLiveViewStep,
} from "@/lib/api-client";

const POLL_INTERVAL_MS = 1000;

/**
 * 表示の保持期間 (done 観測から)。server 側ストアの TTL (live-view-store.ts
 * LIVE_VIEW_TTL_MS = 3 分) と同じ値。server の期限切れは「既に描画済みの
 * <img>」を消せないため、client 側でも同じ窓で表示を畳む (@codex P2:
 * 物件ページを開きっぱなしでも所在の写ったスクショが残り続けない)。
 */
const PANEL_RETENTION_MS = 3 * 60 * 1000;

/**
 * 連続ポーリング失敗の上限。検索 POST が beginLiveView 前に失敗した等で実況が
 * 存在しない (毎回 401/403/404) 場合に、開きっぱなしの物件ページが毎秒叩き
 * 続けないための安全弁 (@codex P2)。通常は searchSettled の最終取得で先に
 * 停止するため、これは二重防御。
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 8;

/**
 * done 観測後の猶予ポーリング回数 (@codex P2: スクショは fire-and-forget で
 * 撮影されるため、最終ステップの画像が done の後から届く。1 枚あたりの撮影
 * timeout は 1.5 秒なので、1 秒間隔 ×3 回で確実に拾える)。有界。
 */
const GRACE_POLLS_AFTER_DONE = 3;

export default function RegistryLivePanel({
  propertyId,
  liveRef,
  searchSettled,
}: {
  propertyId: string;
  liveRef: string;
  /**
   * 検索 POST が決着した (searching を抜けた) か。true になった時点で store は
   * (begin されていれば) route の finally により必ず done 済みなので、最後に
   * 1 回だけ取得してポーリングを止める。begin 前に POST が失敗した場合 (毎回
   * 404) の無限ポーリングをここで確実に断つ (@codex P2)。
   */
  searchSettled: boolean;
}) {
  const [steps, setSteps] = useState<RegistryLiveViewStep[]>([]);
  const [done, setDone] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  // 表示期限切れ (done 観測から PANEL_RETENTION_MS 経過)。スクショの描画を
  // 畳み、文言のみの終了表示に切り替える。
  const [expired, setExpired] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  // 進行中の取得を Promise でも追跡する (@codex P1: 決着時の最終取得が
  // in-flight ガードで素通りすると、直前の取得が done:false を掴んでいた
  // 場合にパネルが永久に「実行中」のまま止まる。決着側は進行中の完了を
  // 待ってから必ず実取得する)。
  const inFlightPromiseRef = useRef<Promise<void> | null>(null);
  const failStreakRef = useRef(0);
  // done 観測後の残り猶予ポーリング数 (null = まだ done を見ていない)。
  const graceRemainingRef = useRef<number | null>(null);

  const stopPolling = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // 1 回分の取得。成功で失敗カウンタをリセットし、done で停止する。
  // 失敗は静かに数えるだけ (表示のエラーは親の責務)・上限で停止 (無限
  // ポーリング防止の二重防御)。既に取得中なら、その取得の Promise を返す
  // (重ね撃ちせず、呼び出し側が完了を待てる)。
  const pollOnce = (isCancelled: () => boolean): Promise<void> => {
    if (inFlightRef.current) {
      return inFlightPromiseRef.current ?? Promise.resolve();
    }
    inFlightRef.current = true;
    const work = (async () => {
      try {
        const res = await fetchRegistryLiveView(propertyId, liveRef);
        if (isCancelled()) return;
        failStreakRef.current = 0;
        setSteps(res.data.steps);
        setDone(res.data.done);
        if (res.data.done) {
          // done 直後に停止すると fire-and-forget 撮影の遅着スクショ (最終
          // ステップ分) を取り逃す (@codex P2)。猶予分だけ追加で拾ってから
          // 停止する。
          if (graceRemainingRef.current === null) {
            graceRemainingRef.current = GRACE_POLLS_AFTER_DONE;
          } else {
            graceRemainingRef.current -= 1;
          }
          if (graceRemainingRef.current <= 0) stopPolling();
        } else {
          graceRemainingRef.current = null;
        }
      } catch {
        failStreakRef.current += 1;
        if (failStreakRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          stopPolling();
        }
      } finally {
        inFlightRef.current = false;
      }
    })();
    inFlightPromiseRef.current = work;
    // 自己参照 TDZ (TS2454) を避けるため、後段の .finally() で片付ける
    // (recorder の inFlightFlushPromiseRef と同じ型)。
    void work.finally(() => {
      if (inFlightPromiseRef.current === work) {
        inFlightPromiseRef.current = null;
      }
    });
    return work;
  };

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    void pollOnce(isCancelled);
    timerRef.current = setInterval(() => {
      void pollOnce(isCancelled);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
    // pollOnce は propertyId/liveRef のみに依存 (render 毎再生成だが effect は
    // key 変更時のみ再実行でよい)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, liveRef]);

  // 検索 POST 決着後: store は (begin されていれば) 必ず done 済み。定期
  // tick を先に止め、進行中の取得があれば完了を待ってから **必ず実取得を
  // 1 回** 行う (@codex P1: in-flight ガードで素通りすると done:false のまま
  // 固まる)。begin 前失敗 = 実況が存在せず毎回 404 のケースでも、この 1 回で
  // 打ち止めになる (開きっぱなしのページが毎秒叩き続けない・@codex P2)。
  useEffect(() => {
    if (!searchSettled) return;
    let cancelled = false;
    void (async () => {
      stopPolling();
      try {
        await inFlightPromiseRef.current;
      } catch {
        // 進行中取得の失敗は最終取得で上書きされる
      }
      if (cancelled) return;
      await pollOnce(() => cancelled);
      // fire-and-forget 撮影の遅着スクショを拾う猶予 (interval は停止済み
      // なので、こちらの経路では明示的に有界回数だけ追い取得する・@codex P2)。
      for (let i = 0; i < GRACE_POLLS_AFTER_DONE && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelled) return;
        await pollOnce(() => cancelled);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSettled]);

  // done 観測 (または POST 決着) から保持期間が過ぎたら表示を畳む (server
  // 期限切れと同じ窓。最終取得が失敗して done が立たなくても必ず畳まれる)。
  useEffect(() => {
    if (!done && !searchSettled) return;
    const t = setTimeout(() => setExpired(true), PANEL_RETENTION_MS);
    return () => clearTimeout(t);
  }, [done, searchSettled]);

  const latestShotStep = [...steps].reverse().find((s) => s.hasShot) ?? null;
  const latestLabel = steps.length > 0 ? steps[steps.length - 1].label : null;

  // 表示期限切れ: スクショ (img) を描画しない終了表示のみ。
  if (expired) {
    return (
      <div
        data-testid="registry-live-panel"
        className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400"
      >
        <span aria-hidden="true">📺</span> 実況の表示期限が切れました
        (スクリーンショットは保存されていません)。
      </div>
    );
  }

  return (
    <div
      data-testid="registry-live-panel"
      className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900"
    >
      {/* 「実行中」の表示判定は store の done に加えて POST 決着 (searchSettled)
          も見る: 最終取得が失敗しても、決着済みなら実行中パルスを出し続けない。 */}
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-700 dark:text-gray-200">
        <span aria-hidden="true">📺</span>
        自動操作の実況
        {!done && !searchSettled && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
        )}
        {(done || searchSettled) && (
          <span className="text-[10px] font-normal text-gray-500 dark:text-gray-400">
            (完了)
          </span>
        )}
      </div>

      {/* 最新スクショ (viewport 全体の縮小表示)。クリックで拡大。 */}
      {latestShotStep ? (
        <button
          type="button"
          onClick={() => setEnlarged(true)}
          data-testid="registry-live-shot-thumb"
          className="block w-full cursor-zoom-in"
          title="クリックで拡大"
        >
          {/* 認可付き・no-store の一時画像。内部 URL に秘匿情報は含まれない。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={registryLiveShotUrl(propertyId, liveRef, latestShotStep.seq)}
            alt="自動操作画面のスクリーンショット"
            className="max-h-56 w-full rounded border border-gray-300 object-contain dark:border-gray-700"
          />
        </button>
      ) : (
        <p
          data-testid="registry-live-waiting"
          className="rounded border border-dashed border-gray-300 px-3 py-6 text-center text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400"
        >
          {latestLabel ?? "実況に接続しています…"}
        </p>
      )}

      {/* ステップ進行 (直近数件)。label は固定文言のみ。 */}
      {steps.length > 0 && (
        <ol
          data-testid="registry-live-steps"
          className="mt-2 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300"
        >
          {steps.slice(-4).map((s) => (
            <li key={s.seq} className="flex items-start gap-1">
              <span aria-hidden="true">{s.seq === steps.length - 1 ? "▶" : "✓"}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
      )}

      {/* 拡大表示 (画面全体をそのまま見たい要望に対応)。 */}
      {enlarged && latestShotStep && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="registry-live-shot-enlarged"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEnlarged(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={registryLiveShotUrl(propertyId, liveRef, latestShotStep.seq)}
            alt="自動操作画面のスクリーンショット (拡大)"
            className="max-h-full max-w-full rounded shadow-lg"
          />
          <button
            type="button"
            onClick={() => setEnlarged(false)}
            className="absolute right-4 top-4 rounded bg-white/90 px-3 py-1 text-sm text-gray-800 shadow"
          >
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}
