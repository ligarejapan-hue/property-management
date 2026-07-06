"use client";

/**
 * Phase 1-G: 調査ピン詳細パネル。
 *
 * - desktop (>= md): 右側固定パネル
 * - mobile: bottom sheet 風 fixed div
 * - GET /api/field-survey/pins/[id] を呼んで詳細を取得 (memo 本文も含む)
 * - own pin のみ編集 UI を出す。他人 pin は read_all/manage を持っていても
 *   閲覧のみ (Phase 1-G 方針)。
 * - memo 表示は React テキストノード。raw HTML 描画は禁止。
 * - lat / lng / accuracy / raw response 全文 / API key / PII を console や
 *   error UI に出さない。
 * - optimistic update しない。保存中は read-only + disable。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FIELD_SURVEY_PIN_STATUSES,
  FIELD_SURVEY_PIN_TYPES,
  buildPinPatch,
  formatPinCreatedAt,
  formatPinStatus,
  formatPinType,
  type FieldSurveyPinStatus,
  type FieldSurveyPinType,
} from "@/lib/field-survey-pin-util";
import { FIELD_SURVEY_MEMO_MAX_LEN } from "@/lib/field-survey-constants";
import {
  useFieldSurveyPinMutations,
  type PinDetail,
} from "@/components/field-survey/use-field-survey-pin-mutations";
import {
  useFieldSurveyPinPhotoMutations,
  type PinPhoto,
} from "@/components/field-survey/use-field-survey-pin-photo-mutations";
import ConvertPinToPropertyModal from "@/components/field-survey/convert-pin-to-property-modal";

interface PinDetailPanelProps {
  pinId: string;
  /** 親 (FieldSurveyMap) が server-side で確定したログインユーザー id。 */
  currentUserId: string;
  /** field_survey:manage を granted で持つか。他人 pin の削除ボタン表示に使う。 */
  canManage?: boolean;
  /** property:write を持つか。候補ピンの「物件にする」ボタン表示に使う。 */
  canWriteProperty?: boolean;
  /** Phase 1-J: 履歴閲覧など完全 read-only 表示。編集/削除/写真追加削除を出さない。 */
  readOnly?: boolean;
  onClose: () => void;
  /** 保存成功 → marker 再 fetch を親側でトリガするためのコールバック。 */
  onUpdated?: (updated: PinDetail) => void;
  /** 論理削除の成功通知 → 親側で panel を閉じ marker 再 fetch する。 */
  onDeleted?: (pinId: string) => void;
}

export default function PinDetailPanel({
  pinId,
  currentUserId,
  canManage = false,
  canWriteProperty = false,
  readOnly = false,
  onClose,
  onUpdated,
  onDeleted,
}: PinDetailPanelProps) {
  const mutations = useFieldSurveyPinMutations();
  const [detail, setDetail] = useState<PinDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftPinType, setDraftPinType] = useState<FieldSurveyPinType>("candidate");
  const [draftStatus, setDraftStatus] = useState<FieldSurveyPinStatus>("open");
  const [draftMemo, setDraftMemo] = useState<string>("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showConvert, setShowConvert] = useState(false);

  // Codex P2 (本 fix): props.pinId は handleSave 内で stale closure になりうる。
  // PATCH レスポンス到達時に「現在表示中の pinId」と一致するかを ref で再確認
  // するため、毎 render で同期する最新値 ref を保持する。
  const latestPinIdRef = useRef(pinId);
  useEffect(() => {
    latestPinIdRef.current = pinId;
  }, [pinId]);

  const loadDetail = useCallback(async () => {
    const r = await mutations.fetchPinDetail(pinId);
    if (!r.ok || !r.data) return;
    // Codex P2: GET 完了時に pinId が他の pin に切り替わっていたら state を
    // 汚さない。pinId と data.id を再照合する。
    if (r.data.id !== pinId) return;
    setDetail(r.data);
    const t = r.data.pinType;
    const s = r.data.status;
    setDraftPinType(
      (FIELD_SURVEY_PIN_TYPES as readonly string[]).includes(t)
        ? (t as FieldSurveyPinType)
        : "candidate",
    );
    setDraftStatus(
      (FIELD_SURVEY_PIN_STATUSES as readonly string[]).includes(s)
        ? (s as FieldSurveyPinStatus)
        : "open",
    );
    setDraftMemo(r.data.memo ?? "");
  }, [mutations, pinId]);

  // Codex P2: pinId が変わった瞬間に古い detail / editing / form / error を
  // 同期 reset する。新しい GET が完了するまで旧 own pin の編集 UI が残らない
  // ようにするため、loadDetail 前にこの reset を必ず実行する。
  useEffect(() => {
    setDetail(null);
    setEditing(false);
    setConfirmingDelete(false);
    setDraftPinType("candidate");
    setDraftStatus("open");
    setDraftMemo("");
    void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinId]);

  // Codex P2: 編集 UI 表示条件は (detail が存在 && detail.id === pinId &&
  // detail.staffUserId === currentUserId)。pin 切替直後の race で旧 own pin
  // の編集 UI が新 pinId に対して残らないことを保証する。
  // manage 権限を持っていても、Phase 1-G では他人 pin の編集 UI を出さない。
  const isFresh = !!detail && detail.id === pinId;
  // readOnly 時は編集系をすべて抑止する。canEditOwn は編集 UI (EditView / 写真) 用。
  const isOwn = isFresh && detail!.staffUserId === currentUserId;
  const canEditOwn = !readOnly && isOwn;
  // Phase 1-I: 論理削除ボタンの表示可否。own または canManage、かつ未アーカイブのみ。
  // canManage は親が field_survey:manage の granted で算出した値だけを使う
  // (閲覧専用の上位権限では false になり、他人 pin に削除ボタンは出ない)。
  // readOnly (履歴閲覧) では削除ボタンも出さない。
  const canDelete =
    !readOnly &&
    isFresh &&
    (isOwn || canManage) &&
    detail!.status !== "archived";

  // 候補ピンの物件化ボタン: 未変換 (propertyId 無し) の candidate で
  // property:write を持つときのみ。サーバー側 (convert endpoint) が認可の正。
  const canConvert =
    !readOnly &&
    isFresh &&
    detail!.pinType === "candidate" &&
    detail!.propertyId == null &&
    canWriteProperty === true;

  const handleConverted = async (_propertyId: string) => {
    setShowConvert(false);
    // 変換後は pin が closed + propertyId 付きに変わる。再取得して表示を更新し、
    // 親に通知して marker を再 fetch させる。
    const refreshed = await mutations.fetchPinDetail(pinId);
    if (refreshed.ok && refreshed.data && refreshed.data.id === pinId) {
      setDetail(refreshed.data);
      onUpdated?.(refreshed.data);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    const targetPinId = pinId;
    if (detail.id !== targetPinId) return;
    const r = await mutations.deletePin(targetPinId);
    if (!r.ok) return; // 失敗は mutations.deleteError 経由で汎用表示
    if (latestPinIdRef.current !== targetPinId) return;
    setConfirmingDelete(false);
    onDeleted?.(targetPinId);
  };

  const handleSave = async () => {
    if (!detail) return;
    // Codex P2: PATCH 直前に stale / 他人 pin への送信を再確認する。
    // saveTargetPinId は PATCH に投げる対象を確定するための snapshot。
    const saveTargetPinId = pinId;
    if (detail.id !== saveTargetPinId) return;
    if (detail.staffUserId !== currentUserId) return;
    const patch = buildPinPatch(
      { pinType: detail.pinType, status: detail.status, memo: detail.memo },
      { pinType: draftPinType, status: draftStatus, memo: draftMemo },
    );
    if (!patch) {
      // 変更なし: PATCH を打たず編集モード終了
      setEditing(false);
      return;
    }
    const r = await mutations.updatePin(saveTargetPinId, patch);
    if (!r.ok || !r.data) return;
    // Codex P2 (本 fix): PATCH レスポンス到達時に、stale closure の pinId では
    // なく「最新の」props.pinId と比較する。
    // 旧実装は r.data.id === (closure 内の) pinId だけ見ていたため、
    // pin A 保存中に pin B へ切替えるとレスポンスが現在表示中の B パネルに
    // 流入していた。3 段ガード:
    //   1) ref が捕捉した saveTargetPinId のままか (= 切替されていない)
    //   2) サーバ応答 id が ref と一致するか
    //   3) サーバ応答 id が捕捉 target と一致するか (念のため二重)
    if (latestPinIdRef.current !== saveTargetPinId) return;
    if (r.data.id !== latestPinIdRef.current) return;
    if (r.data.id !== saveTargetPinId) return;
    setDetail(r.data);
    setEditing(false);
    onUpdated?.(r.data);
  };

  return (
    <aside
      role="complementary"
      aria-label="調査ピン詳細"
      data-testid="pin-detail-panel"
      className={
        "fixed z-40 bg-white dark:bg-gray-900 shadow-xl border border-gray-200 dark:border-gray-700 " +
        // mobile: bottom sheet
        "inset-x-0 bottom-0 max-h-[70vh] overflow-y-auto rounded-t-lg " +
        // desktop: 右側固定パネル
        "md:inset-y-0 md:right-0 md:bottom-auto md:left-auto md:w-96 md:max-h-none md:rounded-none md:rounded-l-lg"
      }
    >
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 p-3">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">調査ピン詳細</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100"
        >
          ×
        </button>
      </div>

      <div className="p-3 text-sm">
        {mutations.detailLoading && (
          <p className="text-[11px] text-gray-500 dark:text-gray-400">読み込み中…</p>
        )}
        {mutations.detailError && (
          <p
            role="status"
            className="rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
          >
            {mutations.detailError}
          </p>
        )}

        {isFresh && !editing && (
          <ReadOnlyView
            detail={detail!}
            isOwn={isOwn}
            canEdit={canEditOwn}
            onEdit={() => setEditing(true)}
            canConvert={canConvert}
            onConvert={() => setShowConvert(true)}
          />
        )}

        {isFresh && editing && canEditOwn && (
          <EditView
            detail={detail!}
            draftPinType={draftPinType}
            draftStatus={draftStatus}
            draftMemo={draftMemo}
            saving={mutations.updateLoading}
            serverError={mutations.updateError}
            onChangePinType={setDraftPinType}
            onChangeStatus={setDraftStatus}
            onChangeMemo={setDraftMemo}
            onCancel={() => {
              // 編集破棄: detail の現状で reset
              setEditing(false);
              setDraftPinType(
                (FIELD_SURVEY_PIN_TYPES as readonly string[]).includes(
                  detail.pinType,
                )
                  ? (detail.pinType as FieldSurveyPinType)
                  : "candidate",
              );
              setDraftStatus(
                (FIELD_SURVEY_PIN_STATUSES as readonly string[]).includes(
                  detail.status,
                )
                  ? (detail.status as FieldSurveyPinStatus)
                  : "open",
              );
              setDraftMemo(detail.memo ?? "");
            }}
            onSave={() => {
              void handleSave();
            }}
          />
        )}

        {isFresh && !editing && (
          <PinPhotoSection
            pinId={pinId}
            canEdit={canEditOwn && detail!.status !== "archived"}
          />
        )}

        {canDelete && !editing && (
          <div className="mt-4 border-t border-gray-200 dark:border-gray-800 pt-3">
            {!confirmingDelete ? (
              <button
                type="button"
                data-testid="pin-detail-delete-button"
                onClick={() => setConfirmingDelete(true)}
                className="w-full rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 px-2 py-1 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-500/20"
              >
                削除
              </button>
            ) : (
              <div
                role="alertdialog"
                aria-modal="true"
                data-testid="pin-detail-delete-confirm"
                className="rounded border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-2 text-[12px] text-red-900 dark:text-red-300"
              >
                <p className="font-semibold">この調査ピンを削除しますか？</p>
                <p className="mt-1 text-[11px]">
                  削除すると地図上の通常表示から非表示になります。
                </p>
                {deleteErrorMessage(mutations.deleteError) && (
                  <p
                    role="status"
                    className="mt-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
                  >
                    {deleteErrorMessage(mutations.deleteError)}
                  </p>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={mutations.deleteLoading}
                    className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDelete();
                    }}
                    disabled={mutations.deleteLoading}
                    data-testid="pin-detail-delete-confirm-button"
                    className="rounded border border-red-600 bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {mutations.deleteLoading ? "削除中…" : "削除する"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {showConvert && (
          <ConvertPinToPropertyModal
            pinId={pinId}
            onClose={() => setShowConvert(false)}
            onConverted={handleConverted}
          />
        )}
      </div>
    </aside>
  );
}

// 削除失敗の汎用文言。権限エラー (403) は削除文脈の文言に差し替える。
// 座標 / memo / 内部情報は出さない。
function deleteErrorMessage(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === "権限がありません。") return "このピンを削除する権限がありません";
  return raw;
}

// Phase 1-H: pin 写真セクション (一覧 / 追加 / プレビュー)。
// - own pin かつ非アーカイブのみ編集 UI を出す (canEdit)。他人 pin は閲覧のみ。
// - thumbnail / preview は fileUrl (/uploads/...) を使う (内部 key は保持しない)。
// - HEIC 等でブラウザが表示できない場合は代替表示を出す (onError)。
// - 画像情報 / fileUrl / fileName を console に出さない。
function PinPhotoSection({
  pinId,
  canEdit,
}: {
  pinId: string;
  canEdit: boolean;
}) {
  const photoMutations = useFieldSurveyPinPhotoMutations();
  const [photos, setPhotos] = useState<PinPhoto[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [brokenIds, setBrokenIds] = useState<Set<string>>(new Set());
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const latestPinIdRef = useRef(pinId);
  useEffect(() => {
    latestPinIdRef.current = pinId;
  }, [pinId]);

  const reload = useCallback(async () => {
    const r = await photoMutations.listPhotos(pinId);
    if (!r.ok || !r.data) return;
    if (latestPinIdRef.current !== pinId) return;
    setPhotos(r.data);
    setBrokenIds(new Set());
  }, [photoMutations, pinId]);

  useEffect(() => {
    setPhotos([]);
    setPreviewId(null);
    setBrokenIds(new Set());
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinId]);

  const handleFilePicked = async (file: File | null) => {
    if (!file) return;
    const r = await photoMutations.uploadPhoto(pinId, file);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    if (r.ok) await reload();
  };

  const handleDelete = async (photoId: string) => {
    const r = await photoMutations.deletePhoto(pinId, photoId);
    if (r.ok) {
      if (previewId === photoId) setPreviewId(null);
      await reload();
    }
  };

  const markBroken = (photoId: string) => {
    setBrokenIds((prev) => {
      const next = new Set(prev);
      next.add(photoId);
      return next;
    });
  };

  const preview = photos.find((p) => p.id === previewId) ?? null;

  return (
    <section data-testid="pin-detail-photos" className="mt-4">
      <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">写真</div>

      {photoMutations.listLoading && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">読み込み中…</p>
      )}
      {photoMutations.listError && (
        <p
          role="status"
          className="rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
        >
          {photoMutations.listError}
        </p>
      )}

      {photos.length === 0 && !photoMutations.listLoading ? (
        <p className="text-[12px] text-gray-500 dark:text-gray-400">(写真なし)</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {photos.map((p) => (
            <li key={p.id} className="relative">
              <button
                type="button"
                onClick={() => setPreviewId(p.id)}
                data-testid="pin-photo-thumb"
                className="block h-20 w-full overflow-hidden rounded border border-gray-200 dark:border-gray-800"
              >
                {brokenIds.has(p.id) ? (
                  <span className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-800 text-center text-[10px] text-gray-500 dark:text-gray-400">
                    プレビューを表示できません
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.thumbnailUrl ?? p.fileUrl}
                    alt="調査ピンの写真"
                    onError={() => markBroken(p.id)}
                    // thumbnailUrl が null の場合は原本 (/uploads 原寸) に fallback するため、
                    // 画面外サムネの先読みを抑止する（F11 uploads 配信負荷・C前段）。
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                )}
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    void handleDelete(p.id);
                  }}
                  disabled={photoMutations.deleteLoading}
                  data-testid="pin-photo-delete"
                  className="absolute right-0 top-0 rounded-bl bg-black/60 px-1 text-[10px] text-white disabled:opacity-60"
                  aria-label="写真を削除"
                >
                  写真を削除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {preview && !brokenIds.has(preview.id) && (
        <div
          data-testid="pin-photo-preview"
          className="mt-2 rounded border border-gray-200 dark:border-gray-800 p-1"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview.fileUrl}
            alt="調査ピンの写真 (プレビュー)"
            onError={() => markBroken(preview.id)}
            className="max-h-64 w-full object-contain"
          />
          <button
            type="button"
            onClick={() => setPreviewId(null)}
            className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 underline hover:text-gray-800 dark:hover:text-gray-100"
          >
            閉じる
          </button>
        </div>
      )}

      {canEdit && (
        <div className="mt-2">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            data-testid="pin-photo-camera-input"
            onChange={(e) => {
              void handleFilePicked(e.target.files?.[0] ?? null);
            }}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="pin-photo-file-input"
            onChange={(e) => {
              void handleFilePicked(e.target.files?.[0] ?? null);
            }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={photoMutations.uploadLoading}
              data-testid="pin-photo-camera"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
            >
              写真を撮る
            </button>
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              disabled={photoMutations.uploadLoading}
              data-testid="pin-photo-add"
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
            >
              写真を追加
            </button>
          </div>
          {photoMutations.uploadError && (
            <p
              role="status"
              className="mt-1 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
            >
              {photoMutations.uploadError}
            </p>
          )}
          {photoMutations.deleteError && (
            <p
              role="status"
              className="mt-1 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
            >
              {photoMutations.deleteError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ReadOnlyView({
  detail,
  isOwn,
  canEdit,
  onEdit,
  canConvert,
  onConvert,
}: {
  detail: PinDetail;
  isOwn: boolean;
  canEdit: boolean;
  onEdit: () => void;
  canConvert?: boolean;
  onConvert?: () => void;
}) {
  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px] text-gray-800 dark:text-gray-100">
        <dt className="text-gray-500 dark:text-gray-400">種類</dt>
        <dd>{formatPinType(detail.pinType)}</dd>
        <dt className="text-gray-500 dark:text-gray-400">状態</dt>
        <dd>{formatPinStatus(detail.status)}</dd>
        <dt className="text-gray-500 dark:text-gray-400">作成者</dt>
        <dd>{isOwn ? "あなた" : "他スタッフ"}</dd>
        <dt className="text-gray-500 dark:text-gray-400">作成日時</dt>
        <dd>{formatPinCreatedAt(detail.createdAt)}</dd>
        <dt className="text-gray-500 dark:text-gray-400">物件</dt>
        <dd>
          {detail.propertyId ? (
            <a
              href={`/properties/${detail.propertyId}`}
              className="text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              紐付け済 →
            </a>
          ) : canConvert ? (
            <button
              type="button"
              onClick={onConvert}
              data-testid="pin-detail-convert-button"
              className="rounded border border-emerald-300 dark:border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
            >
              この場所を物件にする
            </button>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <div className="mt-3">
        <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">メモ</div>
        {/* React text node のみで描画する (raw HTML 描画は使わない)。 */}
        <div
          data-testid="pin-detail-memo"
          className="whitespace-pre-wrap rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-2 py-1 text-[12px] text-gray-800 dark:text-gray-100"
        >
          {detail.memo && detail.memo.length > 0 ? detail.memo : "(なし)"}
        </div>
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          data-testid="pin-detail-edit-button"
          className="mt-3 w-full rounded border border-blue-300 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/20 px-2 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-500/30"
        >
          編集
        </button>
      )}
    </>
  );
}

function EditView({
  detail,
  draftPinType,
  draftStatus,
  draftMemo,
  saving,
  serverError,
  onChangePinType,
  onChangeStatus,
  onChangeMemo,
  onCancel,
  onSave,
}: {
  detail: PinDetail;
  draftPinType: FieldSurveyPinType;
  draftStatus: FieldSurveyPinStatus;
  draftMemo: string;
  saving: boolean;
  serverError: string | null;
  onChangePinType: (v: FieldSurveyPinType) => void;
  onChangeStatus: (v: FieldSurveyPinStatus) => void;
  onChangeMemo: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <>
      <fieldset className="mb-3" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
          種類
        </legend>
        <div className="grid grid-cols-2 gap-1">
          {FIELD_SURVEY_PIN_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-1 text-[11px]">
              <input
                type="radio"
                name="pin-edit-type"
                value={t}
                checked={draftPinType === t}
                onChange={() => onChangePinType(t)}
                data-testid={`pin-edit-type-${t}`}
              />
              <span className="dark:text-gray-200">{formatPinType(t)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mb-3" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
          状態
        </legend>
        <div className="flex flex-wrap gap-2">
          {FIELD_SURVEY_PIN_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1 text-[11px]">
              <input
                type="radio"
                name="pin-edit-status"
                value={s}
                checked={draftStatus === s}
                onChange={() => onChangeStatus(s)}
                data-testid={`pin-edit-status-${s}`}
              />
              <span className="dark:text-gray-200">{formatPinStatus(s)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-200">
          メモ
        </span>
        <textarea
          value={draftMemo}
          disabled={saving}
          onChange={(e) => onChangeMemo(e.target.value)}
          maxLength={FIELD_SURVEY_MEMO_MAX_LEN}
          rows={3}
          data-testid="pin-edit-memo"
          className="w-full rounded border border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none"
        />
        <span className="mt-1 block text-right text-[10px] text-gray-400 dark:text-gray-500">
          {draftMemo.length} / {FIELD_SURVEY_MEMO_MAX_LEN}
        </span>
      </label>

      {serverError && (
        <p
          role="status"
          className="mb-2 rounded border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-300"
        >
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="pin-edit-save-button"
          className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {/* updatedAt の表示はしない (UI 上の Hint としては不要) */}
      <p className="mt-2 text-[10px] text-gray-400 dark:text-gray-500">
        ID: {detail.id.slice(0, 8)}
      </p>
    </>
  );
}
