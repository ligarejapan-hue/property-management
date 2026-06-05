"use client";

/**
 * 現地調査マップ Phase 1-F-2: 位置記録 UI (pure component)。
 *
 * - useFieldSurveyLocationRecorder の戻り値を受け取って描画するだけ。
 *   位置情報取得 / fetch / setInterval は hook 側に閉じる。
 * - active session がある場合のみ呼び出し側 (FieldSurveyMap) が render する。
 * - lat / lng / raw API response を console / UI に出さない。
 */

import { useState } from "react";
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
  const [confirming, setConfirming] = useState(false);
  const recording = status === "recording" || status === "preparing";

  return (
    <div className="mt-2 border-t border-gray-200 pt-2">
      <div className="mb-1 text-xs font-semibold text-gray-600">位置記録</div>
      <StatusLine status={status} isFlushing={isFlushing} />
      <Counters
        saved={savedCount}
        buffered={bufferedCount}
        lastFlushAt={lastFlushAt}
      />
      {isLowAccuracyNow && (
        <p
          className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-800"
          data-testid="location-record-accuracy-warning"
        >
          GPS 精度が低い状態です。屋内・地下では精度が落ちます。
        </p>
      )}

      {!recording && status !== "stopping" && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-2 w-full rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
          data-testid="location-record-start-button"
        >
          位置記録開始
        </button>
      )}
      {(recording || status === "stopping") && (
        <button
          type="button"
          onClick={() => onStop()}
          disabled={status === "stopping"}
          className="mt-2 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="location-record-stop-button"
        >
          位置記録停止
        </button>
      )}

      {error && (
        <p
          role="status"
          className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
        >
          {error}
        </p>
      )}

      {confirming && (
        <ConsentModal
          onCancel={() => setConfirming(false)}
          onAgree={() => {
            setConfirming(false);
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
      ? "text-red-600"
      : status === "error"
        ? "text-amber-700"
        : "text-gray-600";
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
    <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700">
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

function ConsentModal({
  onCancel,
  onAgree,
}: {
  onCancel: () => void;
  onAgree: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="location-record-consent-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-white p-4 text-sm shadow-lg">
        <h3 className="mb-2 text-base font-semibold text-gray-800">
          📍 位置記録の確認
        </h3>
        <ul className="mb-3 ml-4 list-disc space-y-1 text-[11px] text-gray-700">
          <li>
            業務 (巡回) 中のみ位置情報を記録します。常時監視ではありません。
          </li>
          <li>
            この画面を開き、「位置記録開始」を押している間のみ記録されます。
          </li>
          <li>巡回終了または「位置記録停止」で記録は停止します。</li>
          <li>
            ブラウザを閉じたり画面を切り替えると、記録が止まることがあります。
          </li>
          <li>
            未送信の位置情報はブラウザを閉じると失われる可能性があります
            (端末側には保存しません)。
          </li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onAgree}
            className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            同意して記録開始
          </button>
        </div>
      </div>
    </div>
  );
}
