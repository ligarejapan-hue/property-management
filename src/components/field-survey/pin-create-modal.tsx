"use client";

/**
 * Phase 1-G/1-H: 調査ピン作成 modal。
 *
 * - active session がある時のみ呼び出し側 (FieldSurveyMap) が mount する。
 *   modal 内部でも sessionId が空なら保存ボタンを disable する二重ガード。
 * - lat / lng は読み取り専用表示 (props 経由)。modal 内で再取得しない。
 * - 「現在地を使う」は navigator.geolocation.getCurrentPosition の単発取得のみ。
 *   watchPosition は使わない。RouteRecorder hook を流用しない。
 * - localStorage / sessionStorage / IndexedDB を使わない。
 * - lat / lng / raw position / memo / API response 全文 / 画像情報を
 *   console / error UI に出さない。
 *
 * Phase 1-H: 写真 1 枚を選択できる。ユーザーには「ピン保存」と「写真アップロード」を
 * 別操作として見せない (保存ボタン 1 回)。内部は pin create → photo upload の二段階で、
 * 写真だけ失敗した場合の再試行 / 写真なし完了 UI を出す (親が orchestrate)。
 * objectURL は差し替え / unmount で revoke する。
 */

import { useEffect, useRef, useState } from "react";
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
  /**
   * カメラファースト (撮って登録) 経由で既に撮影済みの写真。
   * 指定時は modal を写真選択済み状態で開く (通常の地図タップ経路は null)。
   */
  initialPhotoFile?: File | null;
  /**
   * initialPhotoFile の preview 用 objectURL。親がイベントハンドラ内で生成して
   * 渡す (render 中の createObjectURL を避ける: SSR 安全 + StrictMode の
   * initializer 二重実行でもリークしない)。revoke は modal 側の既存 cleanup
   * (差し替え / unmount) が担う。
   */
  initialPhotoPreviewUrl?: string | null;
  /** 親が把握している active session id。null は modal を mount しない前提。 */
  sessionId: string | null;
  saving: boolean;
  serverError: string | null;
  /** 写真アップロード進行中 (pin 作成後の後段)。 */
  photoUploading: boolean;
  /**
   * pin は作成済みだが写真アップロードだけ失敗した状態。
   * true の間は「写真だけ再試行」「写真なしで完了」を出し、pin を作り直させない。
   */
  photoUploadFailed: boolean;
  /**
   * 写真失敗の具体的な理由 (端末内変換の案内など)。固定文言だけでは
   * 「HEIC は互換性優先設定に」等の対処が伝わらないため併記する。
   */
  photoUploadErrorDetail?: string | null;
  onCancel: () => void;
  onSubmit: (
    input: {
      lat: number;
      lng: number;
      pinType: FieldSurveyPinType;
      memo: string;
      accuracy?: number;
    },
    file: File | null,
  ) => void;
  /** 写真アップロード失敗時の再試行 (親が捕捉済みの file を再送)。 */
  onRetryPhoto: () => void;
  /**
   * 失敗中に別の写真を選び直した通知。親は再試行用の保持 file を差し替える。
   * (変換不能な HEIC 等は同じ file の再試行が必ず再失敗するため、
   *  「別の写真を」という案内文言と操作を一致させる)
   */
  onReplaceRetryPhoto?: (file: File) => void;
  /** 写真なしで完了 (pin は保存済み)。 */
  onFinishWithoutPhoto: () => void;
  onUseCurrentLocation: () => void;
  currentLocationLoading: boolean;
  currentLocationError: string | null;
}

export default function PinCreateModal({
  initialLat,
  initialLng,
  initialPhotoFile,
  initialPhotoPreviewUrl,
  sessionId,
  saving,
  serverError,
  photoUploading,
  photoUploadFailed,
  photoUploadErrorDetail,
  onCancel,
  onSubmit,
  onRetryPhoto,
  onReplaceRetryPhoto,
  onFinishWithoutPhoto,
  onUseCurrentLocation,
  currentLocationLoading,
  currentLocationError,
}: PinCreateModalProps) {
  const [pinType, setPinType] = useState<FieldSurveyPinType>("candidate");
  const [memo, setMemo] = useState<string>("");
  // カメラファースト経由の写真は選択済み状態で開始する。preview の objectURL は
  // 親がイベントハンドラ内で生成済み (render 中に createObjectURL を呼ばない)。
  const [photoFile, setPhotoFile] = useState<File | null>(initialPhotoFile ?? null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(
    initialPhotoPreviewUrl ?? null,
  );

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  // objectURL は差し替え / unmount で必ず revoke する (leak 防止)。
  useEffect(() => {
    return () => {
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    };
  }, [photoPreviewUrl]);

  const busy = saving || photoUploading;
  const canSubmit =
    !!sessionId &&
    !busy &&
    Number.isFinite(initialLat) &&
    Number.isFinite(initialLng);

  const handleFilePicked = (file: File | null) => {
    if (!file) return;
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setPhotoFile(file);
    // 写真失敗中の選び直しは、親が保持する再試行用 file も差し替える
    // (「写真だけ再試行」が新しい写真を送るようにする)。
    if (photoUploadFailed) onReplaceRetryPhoto?.(file);
  };

  const clearPhoto = () => {
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPhotoFile(null);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(
      { lat: initialLat, lng: initialLng, pinType, memo },
      photoFile,
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="pin-create-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-[90vw] sm:max-w-md max-h-[90vh] overflow-y-auto rounded-md bg-white dark:bg-gray-900 p-4 text-sm shadow-lg">
        <h3 className="mb-3 text-base font-semibold text-gray-800 dark:text-gray-100">
          調査ピンを追加
        </h3>

        <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1 text-[11px] text-gray-700 dark:text-gray-200">
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
            className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="pin-create-use-current-location"
          >
            {currentLocationLoading ? "現在地を取得中…" : "現在地を使う"}
          </button>
          {currentLocationError && (
            <p
              role="status"
              className="mt-1 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
            >
              {currentLocationError}
            </p>
          )}
        </div>

        <fieldset className="mb-3" disabled={busy}>
          <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
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
                <span className="dark:text-gray-200">{formatPinType(t)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-200">
            メモ (任意)
          </span>
          <textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={FIELD_SURVEY_MEMO_MAX_LEN}
            rows={3}
            disabled={busy}
            className="w-full rounded border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
            data-testid="pin-create-memo"
            placeholder="例: 解体予定の張り紙あり"
          />
          <span className="mt-1 block text-right text-[10px] text-gray-400 dark:text-gray-500">
            {memo.length} / {FIELD_SURVEY_MEMO_MAX_LEN}
          </span>
        </label>

        {/* 写真 (任意 / 1 枚)。撮影 = 単発の写真取得。動画 / 連続撮影はしない。 */}
        <div className="mb-3">
          <span className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-200">
            写真 (任意)
          </span>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            data-testid="pin-create-photo-camera-input"
            onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="pin-create-photo-file-input"
            onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
          />
          <div className="flex gap-2">
            {/* 失敗中 (photoUploadFailed) も選び直し可: 変換できない写真は
                同じ file の再試行が必ず再失敗するため、「別の写真を」の案内と
                操作を一致させる (選び直しは onReplaceRetryPhoto で親に反映)。 */}
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={busy}
              data-testid="pin-create-photo-camera"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              写真を撮る
            </button>
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={busy}
              data-testid="pin-create-photo-add"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              写真を追加
            </button>
          </div>
          {photoPreviewUrl && (
            <div className="mt-2 flex items-center gap-2">
              {/* プレビューは objectURL。内部 key は UI に出さない。 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoPreviewUrl}
                alt="選択した写真のサムネイル"
                data-testid="pin-create-photo-thumb"
                className="h-16 w-16 rounded border border-gray-200 dark:border-gray-800 object-cover"
              />
              <button
                type="button"
                onClick={clearPhoto}
                disabled={busy || photoUploadFailed}
                data-testid="pin-create-photo-clear"
                className="text-[11px] text-gray-500 dark:text-gray-400 underline hover:text-gray-800 dark:hover:text-gray-100 disabled:opacity-60"
              >
                写真を取り消す
              </button>
            </div>
          )}
        </div>

        {!sessionId && (
          <p
            role="status"
            className="mb-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
          >
            巡回 session が無いため保存できません。巡回を開始してください。
          </p>
        )}

        {serverError && (
          <p
            role="status"
            className="mb-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
          >
            {serverError}
          </p>
        )}

        {photoUploadFailed ? (
          // pin は保存済み。ゼロから作り直させず、写真だけ再試行 / 写真なし完了に誘導。
          <div
            data-testid="pin-create-photo-failed"
            className="rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-2 text-[11px] text-amber-900 dark:text-amber-300"
          >
            <p className="font-semibold text-emerald-700 dark:text-emerald-400">ピンは保存されました</p>
            <p className="mt-1">写真の保存に失敗しました</p>
            {photoUploadErrorDetail && (
              <p className="mt-1" data-testid="pin-create-photo-error-detail">
                {photoUploadErrorDetail}
              </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={onFinishWithoutPhoto}
                disabled={photoUploading}
                data-testid="pin-create-photo-finish-without"
                className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
              >
                写真なしで完了
              </button>
              <button
                type="button"
                onClick={onRetryPhoto}
                disabled={photoUploading}
                data-testid="pin-create-photo-retry"
                className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {photoUploading ? "送信中…" : "写真だけ再試行"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="pin-create-submit"
              className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function formatCoord(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(5);
}
