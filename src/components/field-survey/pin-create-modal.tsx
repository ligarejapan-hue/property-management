"use client";

/**
 * Phase 1-G: 調査ピン作成 modal。
 *
 * - active session がある時のみ呼び出し側 (FieldSurveyMap) が mount する。
 *   modal 内部でも sessionId が空なら保存ボタンを disable する二重ガード。
 * - lat / lng は読み取り専用表示 (props 経由)。modal 内で再取得しない。
 * - 「現在地を使う」は navigator.geolocation.getCurrentPosition の単発取得のみ。
 *   watchPosition は使わない。RouteRecorder hook を流用しない。
 * - localStorage / sessionStorage / IndexedDB を使わない。
 * - lat / lng / raw position / memo / API response 全文を console / error UI に
 *   出さない。
 */

import { useState } from "react";
import {
  FIELD_SURVEY_PIN_TYPES,
  formatPinType,
  type FieldSurveyPinType,
} from "@/lib/field-survey-pin-util";
import { FIELD_SURVEY_MEMO_MAX_LEN } from "@/lib/field-survey-constants";

interface PinCreateModalProps {
  /** 地図クリック / 現在地で確定した座標。表示専用。 */
  initialLat: number;
  initialLng: number;
  /** 親が把握している active session id。null は modal を mount しない前提。 */
  sessionId: string | null;
  saving: boolean;
  serverError: string | null;
  onCancel: () => void;
  onSubmit: (input: {
    lat: number;
    lng: number;
    pinType: FieldSurveyPinType;
    memo: string;
    accuracy?: number;
  }) => void;
  /**
   * 「現在地を使う」ボタンが押された時に呼ばれる。
   * 親側で navigator.geolocation を 1 回呼び、modal を上書きする lat/lng を
   * 渡し直す設計でも良いが、本 modal でも単発取得が完結するようコールバックを
   * 受け取る。
   */
  onUseCurrentLocation: () => void;
  currentLocationLoading: boolean;
  currentLocationError: string | null;
}

export default function PinCreateModal({
  initialLat,
  initialLng,
  sessionId,
  saving,
  serverError,
  onCancel,
  onSubmit,
  onUseCurrentLocation,
  currentLocationLoading,
  currentLocationError,
}: PinCreateModalProps) {
  const [pinType, setPinType] = useState<FieldSurveyPinType>("candidate");
  const [memo, setMemo] = useState<string>("");

  const canSubmit =
    !!sessionId && !saving && Number.isFinite(initialLat) && Number.isFinite(initialLng);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      lat: initialLat,
      lng: initialLng,
      pinType,
      memo: memo,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="pin-create-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-white p-4 text-sm shadow-lg">
        <h3 className="mb-3 text-base font-semibold text-gray-800">
          調査ピンを追加
        </h3>

        {/* 座標は読み取り専用。小数 4 桁に丸めて表示 (raw 値は内部値として保持)。 */}
        <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1 text-[11px] text-gray-700">
          <dt>緯度</dt>
          <dd data-testid="pin-create-lat">{formatCoord(initialLat)}</dd>
          <dt>経度</dt>
          <dd data-testid="pin-create-lng">{formatCoord(initialLng)}</dd>
        </dl>

        <div className="mb-3">
          <button
            type="button"
            onClick={onUseCurrentLocation}
            disabled={currentLocationLoading}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="pin-create-use-current-location"
          >
            {currentLocationLoading ? "現在地を取得中…" : "現在地を使う"}
          </button>
          {currentLocationError && (
            <p
              role="status"
              className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
            >
              {currentLocationError}
            </p>
          )}
        </div>

        <fieldset className="mb-3">
          <legend className="mb-1 text-xs font-semibold text-gray-700">
            種類
          </legend>
          <div className="grid grid-cols-2 gap-1">
            {FIELD_SURVEY_PIN_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1 text-[11px]">
                <input
                  type="radio"
                  name="pin-create-type"
                  value={t}
                  checked={pinType === t}
                  onChange={() => setPinType(t)}
                  data-testid={`pin-create-type-${t}`}
                />
                <span>{formatPinType(t)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-semibold text-gray-700">
            メモ (任意)
          </span>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={FIELD_SURVEY_MEMO_MAX_LEN}
            rows={3}
            className="w-full rounded border border-gray-300 px-2 py-1 text-[12px] focus:border-blue-500 focus:outline-none"
            data-testid="pin-create-memo"
            placeholder="例: 解体予定の張り紙あり"
          />
          <span className="mt-1 block text-right text-[10px] text-gray-400">
            {memo.length} / {FIELD_SURVEY_MEMO_MAX_LEN}
          </span>
        </label>

        {!sessionId && (
          <p
            role="status"
            className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
          >
            巡回 session が無いため保存できません。巡回を開始してください。
          </p>
        )}

        {serverError && (
          <p
            role="status"
            className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
          >
            {serverError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="pin-create-submit"
            className="rounded border border-blue-600 bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "保存中…" : "ピンを追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 小数 5 桁で表示 (raw 値そのままは出さない / Map UI の他の表記と整合)。 */
function formatCoord(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(5);
}
