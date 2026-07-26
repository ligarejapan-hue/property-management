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

export default function RegistryLivePanel({
  propertyId,
  liveRef,
}: {
  propertyId: string;
  liveRef: string;
}) {
  const [steps, setSteps] = useState<RegistryLiveViewStep[]>([]);
  const [done, setDone] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  // 表示期限切れ (done 観測から PANEL_RETENTION_MS 経過)。スクショの描画を
  // 畳み、文言のみの終了表示に切り替える。
  const [expired, setExpired] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      // 応答遅延時に重ねて撃たない (次の tick に譲る)。
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await fetchRegistryLiveView(propertyId, liveRef);
        if (cancelled) return;
        setSteps(res.data.steps);
        setDone(res.data.done);
        if (res.data.done && timerRef.current !== null) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      } catch {
        // 404 (未開始/期限切れ) やネットワーク失敗は静かに次の tick を待つ。
        // 検索本体の成否・エラー表示は親コンポーネントの責務。
      } finally {
        inFlightRef.current = false;
      }
    };
    void poll();
    timerRef.current = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [propertyId, liveRef]);

  // done 観測から保持期間が過ぎたら表示を畳む (server 期限切れと同じ窓)。
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setExpired(true), PANEL_RETENTION_MS);
    return () => clearTimeout(t);
  }, [done]);

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
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-700 dark:text-gray-200">
        <span aria-hidden="true">📺</span>
        自動操作の実況
        {!done && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
        )}
        {done && (
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
