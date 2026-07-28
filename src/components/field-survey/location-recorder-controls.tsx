"use client";

/**
 * 現地調査マップ Phase 1-F-2: 位置記録 UI (pure component)。
 *
 * - useFieldSurveyLocationRecorder の戻り値を受け取って描画するだけ。
 *   位置情報取得 / fetch / setInterval は hook 側に閉じる。
 * - active session がある場合のみ呼び出し側 (FieldSurveyMap) が render する。
 * - ⚠**記録の開始は巡回開始に統合された** (2026-07-29)。ここに残るのは
 *   「一度止めた人が戻すための再開」と「停止」だけ。同意文は通常、巡回開始の
 *   確認 modal 側で初回のみ出す。
 * - ただし**印の無い端末で巡回を復元した場合はその modal を通らない**ため、
 *   「再開」も印を確認し、無ければここで説明を出してから始める
 *   (@codex #333 P2)。文言の正本は location-consent-notice.tsx。
 * - lat / lng / raw API response を console / UI に出さない。
 */

import { useState } from "react";
import { LocationConsentModal } from "@/components/field-survey/location-consent-notice";
import {
  hasLocationConsent,
  markLocationConsent,
} from "@/lib/field-survey-location-consent";
import type { RecorderStatus } from "@/components/field-survey/use-field-survey-location-recorder";

export interface LocationRecorderControlsProps {
  status: RecorderStatus;
  savedCount: number;
  bufferedCount: number;
  lastFlushAt: Date | null;
  isFlushing: boolean;
  isLowAccuracyNow: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}

export default function LocationRecorderControls({
  status,
  savedCount,
  bufferedCount,
  lastFlushAt,
  isFlushing,
  isLowAccuracyNow,
  error,
  onStart,
  onStop,
}: LocationRecorderControlsProps) {
  // ⚠**印の無い端末では「再開」でも説明を出す** (@codex #333 P2)。
  // 巡回を復元しただけの時 (機種変更 / 別ブラウザ / 履歴削除 / この反映より
  // 前に始まった巡回) は巡回開始の確認 modal を通らないため、この経路を素通し
  // にすると「同意文を一度も見ていない端末で押した瞬間に記録が始まる」。
  const [confirming, setConfirming] = useState(false);
  const recording = status === "recording" || status === "preparing";

  return (
    <div className="mt-2 border-t border-gray-200 dark:border-gray-800 pt-2">
      <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">位置記録</div>
      <StatusLine status={status} isFlushing={isFlushing} />
      <Counters
        saved={savedCount}
        buffered={bufferedCount}
        lastFlushAt={lastFlushAt}
      />
      {isLowAccuracyNow && (
        <p
          className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
          data-testid="location-record-accuracy-warning"
        >
          GPS 精度が低い状態です。屋内・地下では精度が落ちます。
        </p>
      )}

      {!recording && status !== "stopping" && (
        <button
          type="button"
          onClick={() => {
            if (hasLocationConsent()) {
              onStart();
              return;
            }
            setConfirming(true);
          }}
          className="mt-2 w-full rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30"
          data-testid="location-record-start-button"
        >
          位置記録を再開
        </button>
      )}
      {(recording || status === "stopping") && (
        <button
          type="button"
          onClick={() => onStop()}
          disabled={status === "stopping"}
          className="mt-2 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          data-testid="location-record-stop-button"
        >
          位置記録停止
        </button>
      )}

      {error && (
        <p
          role="status"
          className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
        >
          {error}
        </p>
      )}

      {confirming && (
        <LocationConsentModal
          onCancel={() => setConfirming(false)}
          onAgree={() => {
            setConfirming(false);
            markLocationConsent();
            onStart();
          }}
        />
      )}
    </div>
  );
}

function StatusLine({
  status,
  isFlushing,
}: {
  status: RecorderStatus;
  isFlushing: boolean;
}) {
  const text = (() => {
    if (isFlushing) return "送信中…";
    switch (status) {
      case "idle":
        return "位置記録停止中";
      case "preparing":
        return "位置情報を準備中…";
      case "recording":
        return "● 位置記録中";
      case "stopping":
        return "停止処理中…";
      case "error":
        return "エラーで停止しました";
    }
  })();
  const color =
    status === "recording"
      ? "text-red-600 dark:text-red-400"
      : status === "error"
        ? "text-amber-700 dark:text-amber-400"
        : "text-gray-600 dark:text-gray-300";
  return (
    <p
      className={`text-[11px] leading-snug ${color}`}
      data-testid="location-record-status"
    >
      {text}
    </p>
  );
}

function Counters({
  saved,
  buffered,
  lastFlushAt,
}: {
  saved: number;
  buffered: number;
  lastFlushAt: Date | null;
}) {
  return (
    <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700 dark:text-gray-200">
      <dt>保存済</dt>
      <dd>{saved}</dd>
      <dt>未送信</dt>
      <dd>{buffered}</dd>
      <dt>最終送信</dt>
      <dd>{lastFlushAt ? formatTime(lastFlushAt) : "—"}</dd>
    </dl>
  );
}

function formatTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
